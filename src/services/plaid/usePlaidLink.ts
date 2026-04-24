/**
 * usePlaidLink — Plaid Link hook with OAuth + State Persistence
 * 
 * Flow: Create token → Open Link → Exchange → Fetch data
 * OAuth: Detects oauth_state_id in URL → resumes session automatically
 * Persistence: Saves state to sessionStorage → survives page reloads
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { usePlaidLink as usePlaidLinkSDK, PlaidLinkOnSuccess, PlaidLinkOnExit, PlaidLinkOnEvent } from 'react-plaid-link';
import {
  createLinkToken,
  exchangeToken,
  fetchAllFinancialData,
  checkAssetReport,
  getProductStatus,
  saveFinancialDataToSupabase,
  signalPrepare,
  type FinancialDataResponse,
  type ProductFetchStatus,
} from './plaidService';
import {
  resolvePlaidRedirectUri,
  shouldUsePlaidRedirectUri,
} from './redirect';

// =====================================================
// Types
// =====================================================

export interface PlaidLinkState {
  step: 'idle' | 'creating_token' | 'ready' | 'linking' | 'exchanging' | 'fetching' | 'done' | 'error';
  linkToken: string | null;
  error: string | null;
  institution: { name: string; id: string } | null;
  balanceStatus: ProductFetchStatus;
  assetsStatus: ProductFetchStatus;
  investmentsStatus: ProductFetchStatus;
  financialData: FinancialDataResponse | null;
  canProceed: boolean;
  productsAvailable: number;
}

export interface UsePlaidLinkReturn extends PlaidLinkState {
  openPlaidLink: () => void;
  retry: () => void;
  isReady: boolean;
  open: () => void;
}

// =====================================================
// Session Storage Persistence
// =====================================================

const STORAGE_KEY = 'plaid_link_state';

interface PersistedState {
  linkToken: string | null;
  expiration: string | null;
  step: PlaidLinkState['step'];
  institution: PlaidLinkState['institution'];
  financialData: FinancialDataResponse | null;
  canProceed: boolean;
  productsAvailable: number;
  balanceStatus: ProductFetchStatus;
  assetsStatus: ProductFetchStatus;
  investmentsStatus: ProductFetchStatus;
  savedAt: number;
}

/** Save current state to sessionStorage */
const persistState = (state: PlaidLinkState, expiration?: string | null) => {
  try {
    const persisted: PersistedState = {
      linkToken: state.linkToken,
      expiration: expiration || null,
      step: state.step,
      institution: state.institution,
      financialData: state.financialData,
      canProceed: state.canProceed,
      productsAvailable: state.productsAvailable,
      balanceStatus: state.balanceStatus,
      assetsStatus: state.assetsStatus,
      investmentsStatus: state.investmentsStatus,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // sessionStorage not available — silently ignore
  }
};

/** Load persisted state from sessionStorage */
const loadPersistedState = (): PersistedState | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedState;
  } catch {
    return null;
  }
};

/** Clear persisted state */
const clearPersistedState = () => {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // silent
  }
};

/** Check if a link token is still valid (not expired) */
const isTokenValid = (expiration: string | null): boolean => {
  if (!expiration) return false;
  const expiresAt = new Date(expiration).getTime();
  // Add 60s buffer — don't use tokens about to expire
  return Date.now() < expiresAt - 60_000;
};

// =====================================================
// Database Restore — Most Stable
// =====================================================

/** Load completed financial data from Supabase database */
const loadFromDatabase = async (userId: string): Promise<PlaidLinkState | null> => {
  try {
    const config = (await import('../../resources/config/config')).default;
    const supabase = config.supabaseClient;
    if (!supabase) {
      console.warn('[Plaid] Database restore skipped: Supabase client not available');
      return null;
    }

    const { data, error } = await supabase
      .from('user_financial_data')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.warn('[Plaid] Database restore query error (ignoring):', error.message);
      return null;
    }

    if (!data) {
      console.log('[Plaid] No financial data found in database');
      return null;
    }

    // Reconstruct state from database
    if (data.status === 'complete' || data.status === 'partial') {
      console.log('[Plaid] 🔄 Restoring from database:', {
        status: data.status,
        institution: data.institution_name,
        products: data.available_products,
      });

      const available = data.available_products || {};
      const productsAvailable = [
        available.balance,
        available.assets,
        available.investments,
      ].filter(Boolean).length;

      return {
        step: 'done',
        linkToken: null,
        error: null,
        institution: data.institution_name && data.institution_id
          ? { name: data.institution_name, id: data.institution_id }
          : null,
        balanceStatus: available.balance ? 'success' : (data.fetch_errors?.balance ? 'error' : 'unavailable'),
        assetsStatus: available.assets ? 'success' : (data.fetch_errors?.assets ? 'error' : 'unavailable'),
        investmentsStatus: available.investments ? 'success' : (data.fetch_errors?.investments ? 'error' : 'unavailable'),
        financialData: {
          status: data.status,
          balance: {
            available: available.balance || false,
            data: data.balances || null,
            error: data.fetch_errors?.balance || null,
            reason: data.fetch_errors?.balance ? 'error' as const : null,
          },
          assets: {
            available: available.assets || false,
            data: data.asset_report || null,
            error: data.fetch_errors?.assets || null,
            reason: data.fetch_errors?.assets ? 'error' as const : null,
          },
          investments: {
            available: available.investments || false,
            data: data.investments || null,
            error: data.fetch_errors?.investments || null,
            reason: data.fetch_errors?.investments ? 'error' as const : null,
          },
          identity: {
            available: available.identity || false,
            data: data.identity_data || null,
            error: data.fetch_errors?.identity || null,
            reason: data.fetch_errors?.identity ? 'error' as const : null,
          },
          authNumbers: {
            available: available.auth || false,
            data: data.auth_numbers || null,
            error: data.fetch_errors?.auth || null,
            reason: data.fetch_errors?.auth ? 'error' as const : null,
          },
          identityMatch: {
            available: available.identity_match || false,
            data: data.identity_match || null,
            error: data.fetch_errors?.identity_match || null,
            reason: data.fetch_errors?.identity_match ? 'error' as const : null,
          },
          summary: {
            products_available: productsAvailable,
            products_total: 3,
            can_proceed: productsAvailable >= 1,
          },
        },
        canProceed: productsAvailable >= 1,
        productsAvailable,
      };
    }

    return null;
  } catch (err) {
    console.warn('[Plaid] Database restore failed:', err);
    return null;
  }
};

// =====================================================
// Hook
// =====================================================

export const usePlaidLinkHook = (userId: string, userEmail?: string): UsePlaidLinkReturn => {
  // Try to restore state from sessionStorage on first render
  const cached = useRef(loadPersistedState());
  const expirationRef = useRef<string | null>(cached.current?.expiration || null);

  const getInitialState = (): PlaidLinkState => {
    const c = cached.current;
    if (!c) return defaultState();

    // If we have completed data, restore it immediately
    if (c.step === 'done' && c.financialData) {
      console.log('[Plaid] 🔄 Restoring completed state from sessionStorage');
      return {
        step: 'done',
        linkToken: c.linkToken,
        error: null,
        institution: c.institution,
        balanceStatus: c.balanceStatus,
        assetsStatus: c.assetsStatus,
        investmentsStatus: c.investmentsStatus,
        financialData: c.financialData,
        canProceed: c.canProceed,
        productsAvailable: c.productsAvailable,
      };
    }

    // If we have a valid link token, restore ready state
    if (c.linkToken && isTokenValid(c.expiration)) {
      console.log('[Plaid] 🔄 Restoring link token from sessionStorage');
      return {
        ...defaultState(),
        step: 'ready',
        linkToken: c.linkToken,
        institution: c.institution,
      };
    }

    // Cached state is stale — start fresh
    return defaultState();
  };

  const [state, setState] = useState<PlaidLinkState>(getInitialState);
  const [dbRestoreComplete, setDbRestoreComplete] = useState(false);
  const dbRestoreAttempted = useRef(false);

  const accessTokenRef = useRef<string | null>(null);
  const assetPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initializedRef = useRef(false);
  const isOAuthResumeRef = useRef(false);

  // Persist state on every change
  useEffect(() => {
    persistState(state, expirationRef.current);
  }, [state]);

  // Detect OAuth redirect: URL has ?oauth_state_id=...
  const getOAuthState = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('oauth_state_id');
  }, []);

  // Get the redirect URI (current page without query params)
  const getRedirectUri = useCallback(() => {
    return resolvePlaidRedirectUri(
      import.meta.env?.VITE_PLAID_REDIRECT_URI,
      window.location.origin,
      window.location.pathname
    );
  }, []);

  // Step 1: Create link token (with OAuth support)
  const initToken = useCallback(async () => {
    if (!userId) return;
    setState(s => ({ ...s, step: 'creating_token', error: null }));

    try {
      const oauthStateId = getOAuthState();
      const redirectUri = getRedirectUri();

      if (oauthStateId) {
        // OAuth RESUME — returning from bank website
        const receivedRedirectUri = window.location.href;
        console.log('[Plaid] 🔄 OAuth resume detected:', { oauthStateId, receivedRedirectUri });
        isOAuthResumeRef.current = true;

        const result = await createLinkToken(userId, userEmail, undefined, receivedRedirectUri);
        expirationRef.current = result.expiration;
        setState(s => ({ ...s, step: 'ready', linkToken: result.link_token }));
      } else {
        // Normal flow — include redirect_uri for OAuth banks
        const canUseRedirectUri = shouldUsePlaidRedirectUri(redirectUri);

        if (!canUseRedirectUri) {
          // Plaid requires HTTPS redirect_uri. Skip on local HTTP so non-OAuth institutions still work.
          console.warn('[Plaid] Skipping redirect_uri because it is not HTTPS:', redirectUri);
        }

        console.log('[Plaid] Creating link token with redirect_uri:', canUseRedirectUri ? redirectUri : 'none');
        const result = await createLinkToken(
          userId,
          userEmail,
          canUseRedirectUri ? redirectUri : undefined,
        );
        expirationRef.current = result.expiration;
        setState(s => ({ ...s, step: 'ready', linkToken: result.link_token }));
      }
    } catch (err: any) {
      console.error('[Plaid] ❌ Token creation failed:', err);
      setState(s => ({ ...s, step: 'error', error: err.message || 'Failed to initialize' }));
    }
  }, [userId, userEmail, getOAuthState, getRedirectUri]);

  // Database restore — try once on mount before anything else
  useEffect(() => {
    if (!userId || dbRestoreAttempted.current) return;
    dbRestoreAttempted.current = true;

    // Only try DB restore if sessionStorage didn't have completed state
    if (state.step === 'done' && state.financialData) {
      console.log('[Plaid] ✅ SessionStorage restore successful, skipping DB check');
      setDbRestoreComplete(true);
      return;
    }

    // Try to restore from database with timeout
    const timeoutId = setTimeout(() => {
      console.warn('[Plaid] Database restore timeout after 5s, proceeding anyway');
      setDbRestoreComplete(true);
    }, 5000);

    (async () => {
      try {
        const dbState = await loadFromDatabase(userId);
        if (dbState) {
          setState(dbState);
          console.log('[Plaid] ✅ Restored from database');
        }
      } catch (err) {
        console.error('[Plaid] Database restore error:', err);
      } finally {
        clearTimeout(timeoutId);
        setDbRestoreComplete(true);
      }
    })();
  }, [userId, state.step, state.financialData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-init — only if we don't already have a valid state
  // IMPORTANT: Wait for DB restore to complete first
  useEffect(() => {
    if (!userId || initializedRef.current) return;

    // Wait for DB restore to complete before initializing
    if (!dbRestoreComplete) return;

    initializedRef.current = true;

    const oauthStateId = getOAuthState();

    // If OAuth resume → always create new token (required by Plaid)
    if (oauthStateId) {
      initToken();
      return;
    }

    // If we restored a completed state → no need to init
    if (state.step === 'done' && state.financialData) {
      console.log('[Plaid] ✅ Already completed — skipping token creation');
      return;
    }

    // If we restored a valid link token → no need to init
    if (state.step === 'ready' && state.linkToken && isTokenValid(expirationRef.current)) {
      console.log('[Plaid] ✅ Valid link token restored — skipping token creation');
      return;
    }

    // No cached state or expired → create fresh token
    initToken();
  }, [userId, initToken, getOAuthState, state.step, state.financialData, dbRestoreComplete]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 2: Handle Plaid Link success
  const handleSuccess: PlaidLinkOnSuccess = useCallback(async (publicToken, metadata) => {
    console.log('[Plaid] ✅ onSuccess', { token: publicToken?.slice(0, 20), institution: metadata?.institution?.name });

    const inst = {
      name: metadata.institution?.name || 'Unknown',
      id: metadata.institution?.institution_id || '',
    };

    setState(s => ({
      ...s, step: 'exchanging', institution: inst,
      balanceStatus: 'loading', assetsStatus: 'loading', investmentsStatus: 'loading',
    }));

    try {
      // Exchange token
      console.log('[Plaid] Exchanging token...');
      const exchange = await exchangeToken(publicToken, userId, inst.name, inst.id);
      console.log('[Plaid] ✅ Exchange done:', { item_id: exchange.item_id });
      accessTokenRef.current = exchange.access_token;

      // Signal: opt-in to data collection (background, non-blocking)
      signalPrepare(exchange.access_token)
        .then(r => console.log('[Plaid] Signal prepare:', r.success ? '✅ done' : '⚠️ skipped'))
        .catch(() => {});

      setState(s => ({ ...s, step: 'fetching' }));

      // Fetch financial data
      console.log('[Plaid] Fetching financial data...');
      const result = await fetchAllFinancialData(exchange.access_token, userId);
      console.log('[Plaid] ✅ Result:', {
        status: result.status,
        balance: result.balance.available,
        assets: result.assets.available,
        investments: result.investments.available,
      });

      setState(s => ({
        ...s, step: 'done', financialData: result,
        balanceStatus: getProductStatus(result.balance),
        assetsStatus: getProductStatus(result.assets),
        investmentsStatus: getProductStatus(result.investments),
        canProceed: result.summary.can_proceed,
        productsAvailable: result.summary.products_available,
      }));

      // Save to Supabase (background)
      saveFinancialDataToSupabase(userId, result, inst.name, inst.id, exchange.item_id, exchange.access_token)
        .catch(e => console.warn('[Plaid] Save failed:', e));

      // Poll assets if pending
      if (getProductStatus(result.assets) === 'pending' && result.assets.data?.asset_report_token) {
        pollAssets(result.assets.data.asset_report_token);
      }
    } catch (err: any) {
      console.error('[Plaid] ❌ Error:', err);
      setState(s => ({
        ...s, step: 'error', error: err.message || 'Failed to connect',
        balanceStatus: 'error', assetsStatus: 'error', investmentsStatus: 'error',
      }));
    }
  }, [userId]);

  // Handle exit
  const handleExit: PlaidLinkOnExit = useCallback((err, metadata) => {
    console.log('[Plaid] 🚪 onExit', { error: err, status: metadata?.status });
    if (err) {
      setState(s => ({
        ...s, step: 'error',
        error: `Connection interrupted: ${err.display_message || err.error_message || 'Unknown error'}`,
      }));
    }
  }, []);

  // Log events
  const handleEvent: PlaidLinkOnEvent = useCallback((eventName, metadata) => {
    console.log(`[Plaid] 📡 ${eventName}`, metadata);
  }, []);

  // Asset polling
  const pollAssets = useCallback((token: string) => {
    if (assetPollRef.current) clearInterval(assetPollRef.current);
    let attempts = 0;

    assetPollRef.current = setInterval(async () => {
      if (++attempts > 10) { clearInterval(assetPollRef.current!); return; }
      try {
        const result = await checkAssetReport(token, userId);
        if (result.status === 'complete') {
          clearInterval(assetPollRef.current!);
          setState(s => ({
            ...s, assetsStatus: 'success',
            productsAvailable: (s.productsAvailable || 0) + 1,
            financialData: s.financialData ? {
              ...s.financialData,
              assets: { available: true, data: result.data, error: null, reason: null },
            } : s.financialData,
          }));
        }
      } catch { /* silent */ }
    }, 5000);
  }, [userId]);

  // Cleanup
  useEffect(() => () => { if (assetPollRef.current) clearInterval(assetPollRef.current); }, []);

  // Plaid SDK — receivedRedirectUri tells SDK this is an OAuth resume
  const { open, ready } = usePlaidLinkSDK({
    token: state.linkToken,
    onSuccess: handleSuccess,
    onExit: handleExit,
    onEvent: handleEvent,
    receivedRedirectUri: isOAuthResumeRef.current ? window.location.href : undefined,
  });

  // Auto-open on OAuth resume: when token is ready and it's an OAuth return
  useEffect(() => {
    if (ready && isOAuthResumeRef.current && state.step === 'ready') {
      console.log('[Plaid] 🔄 Auto-opening Plaid Link for OAuth resume...');
      setState(s => ({ ...s, step: 'linking' }));
      open();
      // Clean up the oauth_state_id from URL without reload
      const cleanUrl = `${window.location.origin}${window.location.pathname}`;
      window.history.replaceState({}, '', cleanUrl);
      isOAuthResumeRef.current = false;
    }
  }, [ready, state.step, open]);

  // Public API
  const openPlaidLink = useCallback(() => {
    if (ready) { setState(s => ({ ...s, step: 'linking' })); open(); }
  }, [ready, open]);

  const retry = useCallback(() => {
    if (assetPollRef.current) {
      clearInterval(assetPollRef.current);
      assetPollRef.current = null;
    }
    clearPersistedState();
    setState(defaultState());
    accessTokenRef.current = null;
    initializedRef.current = false;
    expirationRef.current = null;
    initToken();
  }, [initToken]);

  return {
    ...state, openPlaidLink, retry,
    isReady: ready && state.step === 'ready',
    open: openPlaidLink,
  };
};

// Default empty state
const defaultState = (): PlaidLinkState => ({
  step: 'idle',
  linkToken: null,
  error: null,
  institution: null,
  balanceStatus: 'idle',
  assetsStatus: 'idle',
  investmentsStatus: 'idle',
  financialData: null,
  canProceed: false,
  productsAvailable: 0,
});

export default usePlaidLinkHook;
