/**
 * Plaid Service — Clean API calls to Supabase Edge Functions
 * 
 * Simple, no-frills service. All sensitive operations happen server-side.
 */

import { getAuthenticatedSession } from "../../auth/session";

// =====================================================
// Types
// =====================================================

export type ProductFetchStatus = 'idle' | 'loading' | 'success' | 'unavailable' | 'error' | 'pending';

export interface ProductResult {
  available: boolean;
  data: any | null;
  error: string | null;
  reason: 'not_supported' | 'error' | null;
}

export interface FinancialDataResponse {
  status: 'complete' | 'partial' | 'failed';
  balance: ProductResult;
  assets: ProductResult;
  investments: ProductResult;
  identity: ProductResult;
  authNumbers: ProductResult;
  identityMatch: ProductResult;
  summary: {
    products_available: number;
    products_total: number;
    can_proceed: boolean;
  };
}

// =====================================================
// Config
// =====================================================

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

const getAnonKey = (): string => {
  try {
    // @ts-ignore
    return import.meta.env?.VITE_SUPABASE_ANON_KEY || '';
  } catch { return ''; }
};

const getUserAccessToken = async (): Promise<string> => {
  try {
    const config = (await import('../../resources/config/config')).default;
    const supabase = config.supabaseClient;
    if (!supabase) return getAnonKey();
    const session = await getAuthenticatedSession(supabase);
    return session.access_token || getAnonKey();
  } catch { return getAnonKey(); }
};

const getHeaders = (token?: string) => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token || getAnonKey()}`,
});

const getFunctionsUrl = (): string => {
  if (!SUPABASE_URL) {
    throw new Error('VITE_SUPABASE_URL is not configured');
  }
  return SUPABASE_FUNCTIONS_URL;
};

// =====================================================
// API Calls
// =====================================================

/** Create a Plaid Link token (supports OAuth redirect/resume) */
export const createLinkToken = async (
  userId: string,
  userEmail?: string,
  redirectUri?: string,
  receivedRedirectUri?: string,
) => {
  console.log('[Plaid:createLinkToken] 🚀 Starting...', { userId: userId?.slice(0, 8), userEmail, redirectUri, receivedRedirectUri: receivedRedirectUri?.slice(0, 50) });
  const token = await getUserAccessToken();
  console.log('[Plaid:createLinkToken] Auth token:', token ? `${token.slice(0, 20)}...` : 'MISSING');
  const body: Record<string, any> = { userId, userEmail };
  if (redirectUri) body.redirectUri = redirectUri;
  if (receivedRedirectUri) body.receivedRedirectUri = receivedRedirectUri;

  console.log('[Plaid:createLinkToken] POST', `${getFunctionsUrl()}/create-link-token`, body);
  const res = await fetch(`${getFunctionsUrl()}/create-link-token`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify(body),
  });
  console.log('[Plaid:createLinkToken] Response status:', res.status, res.statusText);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('[Plaid:createLinkToken] ❌ FAILED:', err);
    throw new Error(err.error || 'Failed to create link token');
  }
  const result = await res.json();
  console.log('[Plaid:createLinkToken] ✅ Got link_token:', result.link_token?.slice(0, 30), '| expires:', result.expiration);
  return result as { link_token: string; expiration: string };
};

/** Exchange public token for access token */
export const exchangeToken = async (
  publicToken: string, userId: string,
  institutionName?: string, institutionId?: string,
) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/exchange-public-token`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ publicToken, userId, institutionName, institutionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to exchange token');
  }
  return res.json() as Promise<{ access_token: string; item_id: string }>;
};

/** Fetch auth numbers (account number, routing number, account type) from Plaid */
export const fetchAuthNumbers = async (accessToken: string) => {
  try {
    const token = await getUserAccessToken();
    const res = await fetch(`${getFunctionsUrl()}/get-auth-numbers`, {
      method: 'POST',
      headers: getHeaders(token),
      body: JSON.stringify({ accessToken }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[Plaid] Auth numbers error:', err);
      return null;
    }
    const data = await res.json();
    console.log('[Plaid] Auth numbers fetched successfully');
    return data as {
      accounts: Array<{ account_id: string; name: string; subtype: string; type: string }>;
      numbers: { ach: Array<{ account: string; routing: string; wire_routing: string; account_id: string }> };
    };
  } catch (e: any) {
    console.error('[Plaid] Auth numbers fetch failed:', e.message);
    return null;
  }
};

/** Fetch balance */
const fetchBalance = async (accessToken: string, userId: string): Promise<ProductResult> => {
  try {
    const token = await getUserAccessToken();
    const res = await fetch(`${getFunctionsUrl()}/get-balance`, {
      method: 'POST', headers: getHeaders(token),
      body: JSON.stringify({ accessToken, userId }),
    });
    if (!res.ok) {
      if (res.status === 400) return { available: false, data: null, error: null, reason: 'not_supported' };
      const err = await res.json().catch(() => ({}));
      return { available: false, data: null, error: err.error || 'Failed', reason: 'error' };
    }
    return { available: true, data: await res.json(), error: null, reason: null };
  } catch (e: any) {
    return { available: false, data: null, error: e.message, reason: 'error' };
  }
};

/** Fetch assets */
const fetchAssets = async (accessToken: string, userId: string): Promise<ProductResult> => {
  try {
    const token = await getUserAccessToken();
    const res = await fetch(`${getFunctionsUrl()}/asset-report-create`, {
      method: 'POST', headers: getHeaders(token),
      body: JSON.stringify({ accessToken, userId }),
    });
    if (!res.ok) {
      if (res.status === 400) return { available: false, data: null, error: null, reason: 'not_supported' };
      const err = await res.json().catch(() => ({}));
      return { available: false, data: null, error: err.error || 'Failed', reason: 'error' };
    }
    const data = await res.json();
    if (data.status === 'pending') return { available: false, data, error: null, reason: null };
    return { available: true, data, error: null, reason: null };
  } catch (e: any) {
    return { available: false, data: null, error: e.message, reason: 'error' };
  }
};

/** Fetch investments */
const fetchInvestments = async (accessToken: string, userId: string): Promise<ProductResult> => {
  try {
    const token = await getUserAccessToken();
    const res = await fetch(`${getFunctionsUrl()}/investments-holdings`, {
      method: 'POST', headers: getHeaders(token),
      body: JSON.stringify({ accessToken, userId }),
    });
    if (!res.ok) {
      if (res.status === 404) return { available: false, data: null, error: 'Service unavailable', reason: 'error' };
      if (res.status === 400) return { available: false, data: null, error: null, reason: 'not_supported' };
      const err = await res.json().catch(() => ({}));
      return { available: false, data: null, error: err.error || 'Failed', reason: 'error' };
    }
    return { available: true, data: await res.json(), error: null, reason: null };
  } catch (e: any) {
    return { available: false, data: null, error: e.message, reason: 'error' };
  }
};

/** Fetch identity data (name, email, phone, address from bank) */
const fetchIdentity = async (accessToken: string): Promise<ProductResult> => {
  try {
    const token = await getUserAccessToken();
    const res = await fetch(`${getFunctionsUrl()}/get-identity`, {
      method: 'POST', headers: getHeaders(token),
      body: JSON.stringify({ accessToken }),
    });
    if (!res.ok) {
      if (res.status === 400) return { available: false, data: null, error: null, reason: 'not_supported' };
      const err = await res.json().catch(() => ({}));
      return { available: false, data: null, error: err.error || 'Failed', reason: 'error' };
    }
    return { available: true, data: await res.json(), error: null, reason: null };
  } catch (e: any) {
    return { available: false, data: null, error: e.message, reason: 'error' };
  }
};

/** Match user identity against bank account owner data */
export const fetchIdentityMatch = async (
  accessToken: string,
  userData?: { legal_name?: string; phone_number?: string; email_address?: string; address?: any },
): Promise<ProductResult> => {
  try {
    const token = await getUserAccessToken();
    const res = await fetch(`${getFunctionsUrl()}/identity-match`, {
      method: 'POST', headers: getHeaders(token),
      body: JSON.stringify({ accessToken, ...userData }),
    });
    if (!res.ok) {
      if (res.status === 400) return { available: false, data: null, error: null, reason: 'not_supported' };
      const err = await res.json().catch(() => ({}));
      return { available: false, data: null, error: err.error || 'Failed', reason: 'error' };
    }
    return { available: true, data: await res.json(), error: null, reason: null };
  } catch (e: any) {
    return { available: false, data: null, error: e.message, reason: 'error' };
  }
};

/** Wrap fetchAuthNumbers as a ProductResult */
const fetchAuth = async (accessToken: string): Promise<ProductResult> => {
  try {
    const data = await fetchAuthNumbers(accessToken);
    if (!data) return { available: false, data: null, error: null, reason: 'not_supported' };
    return { available: true, data, error: null, reason: null };
  } catch (e: any) {
    return { available: false, data: null, error: e.message, reason: 'error' };
  }
};

/** Fetch all 6 products in parallel */
export const fetchAllFinancialData = async (
  accessToken: string, userId: string,
): Promise<FinancialDataResponse> => {
  const [b, a, i, id, auth, idMatch] = await Promise.allSettled([
    fetchBalance(accessToken, userId),
    fetchAssets(accessToken, userId),
    fetchInvestments(accessToken, userId),
    fetchIdentity(accessToken),
    fetchAuth(accessToken),
    fetchIdentityMatch(accessToken),
  ]);

  const errResult = { available: false, data: null, error: 'Network error', reason: 'error' as const };
  const balance = b.status === 'fulfilled' ? b.value : errResult;
  const assets = a.status === 'fulfilled' ? a.value : errResult;
  const investments = i.status === 'fulfilled' ? i.value : errResult;
  const identity = id.status === 'fulfilled' ? id.value : errResult;
  const authNumbers = auth.status === 'fulfilled' ? auth.value : errResult;
  const identityMatch = idMatch.status === 'fulfilled' ? idMatch.value : errResult;

  const count = [balance, assets, investments, identity, authNumbers, identityMatch].filter(r => r.available).length;

  return {
    status: count >= 4 ? 'complete' : count > 0 ? 'partial' : 'failed',
    balance, assets, investments, identity, authNumbers, identityMatch,
    summary: { products_available: count, products_total: 6, can_proceed: count >= 1 },
  };
};

/** Check asset report status */
export const checkAssetReport = async (assetReportToken: string, userId: string) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/asset-report-create`, {
    method: 'POST', headers: getHeaders(token),
    body: JSON.stringify({ assetReportToken, userId, action: 'get' }),
  });
  if (!res.ok) throw new Error('Failed to check asset report');
  return res.json() as Promise<{ status: 'complete' | 'pending'; data?: any }>;
};

/** Save financial data to Supabase */
export const saveFinancialDataToSupabase = async (
  userId: string, data: FinancialDataResponse,
  institutionName?: string, institutionId?: string, itemId?: string, accessToken?: string,
) => {
  try {
    const config = (await import('../../resources/config/config')).default;
    const supabase = config.supabaseClient;
    if (!supabase) return;

    const errors: Record<string, string> = {};
    if (data.balance.error) errors.balance = data.balance.error;
    if (data.assets.error) errors.assets = data.assets.error;
    if (data.investments.error) errors.investments = data.investments.error;
    if (data.identity?.error) errors.identity = data.identity.error;
    if (data.authNumbers?.error) errors.auth = data.authNumbers.error;
    if (data.identityMatch?.error) errors.identity_match = data.identityMatch.error;

    await supabase.from('user_financial_data').upsert({
      user_id: userId,
      plaid_item_id: itemId || null,
      plaid_access_token: accessToken || null,
      institution_name: institutionName || null,
      institution_id: institutionId || null,
      balances: data.balance.available ? data.balance.data : null,
      asset_report: data.assets.available ? data.assets.data : null,
      asset_report_token: data.assets.data?.asset_report_token || null,
      investments: data.investments.available ? data.investments.data : null,
      identity_data: data.identity?.available ? data.identity.data : null,
      auth_numbers: data.authNumbers?.available ? data.authNumbers.data : null,
      identity_match: data.identityMatch?.available ? data.identityMatch.data : null,
      available_products: {
        balance: data.balance.available,
        assets: data.assets.available,
        investments: data.investments.available,
        identity: data.identity?.available || false,
        auth: data.authNumbers?.available || false,
        identity_match: data.identityMatch?.available || false,
      },
      status: data.status,
      fetch_errors: Object.keys(errors).length > 0 ? errors : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    console.log('[Plaid] ✅ Data saved to Supabase');
  } catch (err) {
    console.warn('[Plaid] Save failed:', err);
  }
};

// =====================================================
// Utilities
// =====================================================

export const formatCurrency = (amount: number | null | undefined, currency = 'USD'): string => {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(amount);
};

export const getHeaderTitle = (count: number): string => {
  if (count === 3) return '✨ Complete Financial Profile';
  if (count === 2) return '📊 Financial Profile Verified';
  if (count === 1) return '💰 Account Verified';
  return '⚠️ Unable to Verify';
};

export const getProductStatus = (product: ProductResult): ProductFetchStatus => {
  if (product.available) return product.data?.status === 'pending' ? 'pending' : 'success';
  if (product.reason === 'not_supported') return 'unavailable';
  if (product.error) return 'error';
  if (product.data?.status === 'pending') return 'pending';
  return 'idle';
};

// =====================================================
// Signal — ACH Transaction Risk Assessment
// =====================================================

/** Prepare an Item for Signal Transaction Scores (call after token exchange) */
export const signalPrepare = async (accessToken: string) => {
  try {
    const token = await getUserAccessToken();
    const res = await fetch(`${getFunctionsUrl()}/signal-prepare`, {
      method: 'POST', headers: getHeaders(token),
      body: JSON.stringify({ accessToken }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('[Plaid] Signal prepare failed:', err.error);
      return { success: false, error: err.error };
    }
    console.log('[Plaid] ✅ Signal prepared for Item');
    return { success: true, ...(await res.json()) };
  } catch (e: any) {
    console.warn('[Plaid] Signal prepare error:', e.message);
    return { success: false, error: e.message };
  }
};

/** Evaluate ACH transaction return risk */
export const signalEvaluate = async (params: {
  accessToken: string;
  accountId: string;
  clientTransactionId: string;
  amount: number;
  clientUserId?: string;
  isRecurring?: boolean;
  defaultPaymentMethod?: 'SAME_DAY_ACH' | 'STANDARD_ACH' | 'MULTIPLE_PAYMENT_METHODS';
  rulesetKey?: string;
  user?: { name?: { given_name?: string; family_name?: string }; phone_number?: string; email_address?: string; address?: any };
  device?: { ip_address?: string; user_agent?: string };
}) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/signal-evaluate`, {
    method: 'POST', headers: getHeaders(token),
    body: JSON.stringify({
      accessToken: params.accessToken,
      account_id: params.accountId,
      client_transaction_id: params.clientTransactionId,
      amount: params.amount,
      client_user_id: params.clientUserId,
      is_recurring: params.isRecurring,
      default_payment_method: params.defaultPaymentMethod,
      ruleset_key: params.rulesetKey,
      user: params.user,
      device: params.device,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Signal evaluate failed');
  }
  return res.json() as Promise<{
    scores: {
      customer_initiated_return_risk: { score: number; risk_tier: number };
      bank_initiated_return_risk: { score: number; risk_tier: number };
    };
    core_attributes: Record<string, any>;
    ruleset?: { ruleset_key: string; result: 'ACCEPT' | 'REROUTE' | 'REVIEW'; triggered_rule_details?: any };
    warnings: any[];
    request_id: string;
  }>;
};

/** Report whether you initiated an ACH transaction */
export const signalDecisionReport = async (params: {
  clientTransactionId: string;
  initiated: boolean;
  decisionOutcome?: 'APPROVE' | 'REVIEW' | 'REJECT' | 'TAKE_OTHER_RISK_MEASURES' | 'NOT_EVALUATED';
  paymentMethod?: 'SAME_DAY_ACH' | 'STANDARD_ACH' | 'MULTIPLE_PAYMENT_METHODS';
  daysFundsOnHold?: number;
  amountInstantlyAvailable?: number;
}) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/signal-decision-report`, {
    method: 'POST', headers: getHeaders(token),
    body: JSON.stringify({
      client_transaction_id: params.clientTransactionId,
      initiated: params.initiated,
      decision_outcome: params.decisionOutcome,
      payment_method: params.paymentMethod,
      days_funds_on_hold: params.daysFundsOnHold,
      amount_instantly_available: params.amountInstantlyAvailable,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Signal decision report failed');
  }
  return res.json() as Promise<{ request_id: string }>;
};

/** Report a return for an ACH transaction */
export const signalReturnReport = async (params: {
  clientTransactionId: string;
  returnCode: string;
  returnedAt?: string;
}) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/signal-return-report`, {
    method: 'POST', headers: getHeaders(token),
    body: JSON.stringify({
      client_transaction_id: params.clientTransactionId,
      return_code: params.returnCode,
      returned_at: params.returnedAt,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Signal return report failed');
  }
  return res.json() as Promise<{ request_id: string }>;
};

// =====================================================
// Sandbox Testing — Bypass Plaid Link UI
// =====================================================

export interface SandboxTestResult {
  success: boolean;
  item_id: string;
  institution: { name: string; id: string };
  products: {
    balance: { available: boolean; accounts: number; error: string | null };
    investments: { available: boolean; holdings: number; error: string | null };
    assets: { available: boolean; token: string | null; error: string | null };
  };
  summary: {
    products_available: number;
    products_total: number;
    status: string;
    saved_to_db: boolean;
  };
}

/**
 * Create a sandbox test Item (bypasses Plaid Link UI).
 * Uses /sandbox/public_token/create → exchange → fetch all → save.
 * SANDBOX ONLY.
 */
export const createSandboxTestItem = async (
  userId: string,
  institutionId = 'ins_109508',
): Promise<SandboxTestResult> => {
  const token = await getUserAccessToken();
  const res = await fetch(`${SUPABASE_URL}/sandbox-create-test-item`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ userId, institutionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Sandbox test item creation failed');
  }
  return res.json() as Promise<SandboxTestResult>;
};
