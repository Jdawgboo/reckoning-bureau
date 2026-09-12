import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { TRPCContext } from '../init';
import { createRouter, publicProcedure } from '../init';
import { loggedProcedure } from '../middleware/action-logging';

const CASES_DIR = 'common/cases';
const FILING_FEE_CENTS = 2900;
const FILING_CURRENCY = 'usd';
const FILING_ITEM_NAME = 'Demand letter preparation';

interface PaymentRecord {
  docket: string;
  checkoutSessionId: string;
  checkoutUrl: string;
  status: 'pending' | 'paid';
  createdAt: string;
  verifiedAt: string | null;
}

interface StripeMcpConfig {
  url: string;
  headers: Record<string, string>;
}

function paymentPath(docket: string): string {
  return `${CASES_DIR}/${docket}.payment.json`;
}

function isDocket(value: string): boolean {
  return /^RB-\d{4}-\d{4}$/.test(value);
}

async function readJson<T>(ctx: TRPCContext, path: string): Promise<T | null> {
  if (!(await ctx.storage.exists(path))) return null;
  return JSON.parse((await ctx.storage.readFile(path)).toString('utf8')) as T;
}

async function writeJson(ctx: TRPCContext, path: string, value: unknown): Promise<void> {
  await ctx.storage.writeFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

/** The MCP capability stays server-side; it never enters model context or browser state. */
function stripeConfig(): StripeMcpConfig {
  const configPath = join(process.cwd(), '..', '.agent', 'mcp.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mcpServers?: Record<string, { url?: unknown; headers?: unknown }>;
  };
  const stripe = raw.mcpServers?.stripe;
  const url = typeof stripe?.url === 'string' ? stripe.url : '';
  const headers = stripe?.headers && typeof stripe.headers === 'object'
    ? (stripe.headers as Record<string, string>)
    : {};
  if (!url || !headers['X-MCP-Auth']) {
    throw new Error('Hosted checkout is not configured.');
  }
  return { url, headers };
}

function parseMcpPayload(body: string): Record<string, unknown> {
  for (const block of body.split(/\r?\n\r?\n/).reverse()) {
    const data = block.split(/\r?\n/).find((line) => line.startsWith('data:'));
    if (data) return JSON.parse(data.slice(5).trim()) as Record<string, unknown>;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function mcpRequest(
  config: StripeMcpConfig,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<{ body: Record<string, unknown>; sessionId: string | null }> {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...config.headers,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Hosted checkout request failed (${response.status}).`);
  const body = parseMcpPayload(text);
  if (body.error) throw new Error('Hosted checkout request was rejected.');
  return { body, sessionId: response.headers.get('mcp-session-id') };
}

async function callStripe(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = stripeConfig();
  const initialized = await mcpRequest(config, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'reckoning-bureau-payment-bridge', version: '1.0' },
  });
  if (!initialized.sessionId) throw new Error('Hosted checkout session could not be established.');
  const called = await mcpRequest(
    config,
    'tools/call',
    { name: tool, arguments: args },
    initialized.sessionId,
  );
  const result = called.body.result;
  if (!result || typeof result !== 'object') throw new Error('Hosted checkout returned no result.');
  const content = Array.isArray((result as { content?: unknown }).content)
    ? ((result as { content: Array<{ type?: unknown; text?: unknown }> }).content)
    : [];
  const text = content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n');
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('Hosted checkout returned an unreadable result.');
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Composio may wrap Stripe data; walk only known object values, never logs or arbitrary strings. */
function findStripeSession(value: unknown): Record<string, unknown> | null {
  const record = asObject(value);
  if (!record) return null;
  if (typeof record.id === 'string' && record.id.startsWith('cs_')) return record;
  for (const child of Object.values(record)) {
    const found = findStripeSession(child);
    if (found) return found;
  }
  return null;
}

function returnUrls(returnUrl: string): { successUrl: string; cancelUrl: string } {
  const parsed = new URL(returnUrl);
  if (parsed.protocol !== 'https:') throw new Error('Secure return URL required.');
  const separator = returnUrl.includes('?') ? '&' : '?';
  return {
    successUrl: `${returnUrl}${separator}checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${returnUrl}${separator}checkout=cancelled`,
  };
}

export function createPaymentsRouter() {
  return createRouter({
    getStatus: publicProcedure
      .input(z.object({ docket: z.string().min(1).max(40) }))
      .query(async ({ input, ctx }) => {
        if (!isDocket(input.docket)) return { status: 'none' as const };
        const payment = await readJson<PaymentRecord>(ctx, paymentPath(input.docket));
        return { status: payment?.status ?? ('none' as const) };
      }),

    createCheckout: loggedProcedure
      .input(z.object({ docket: z.string().min(1).max(40), returnUrl: z.string().url().max(500) }))
      .mutation(async ({ input, ctx }) => {
        if (!isDocket(input.docket) || !(await ctx.storage.exists(`${CASES_DIR}/${input.docket}.json`))) {
          return { ok: false as const, reason: 'unknown_docket', logSummary: 'Checkout declined: unknown docket.' };
        }
        const existing = await readJson<PaymentRecord>(ctx, paymentPath(input.docket));
        if (existing?.status === 'paid') {
          return { ok: true as const, status: 'paid' as const, logSummary: `${input.docket}: filing fee already verified.` };
        }
        console.log('[payments.createCheckout] requested:', { docket: input.docket });
        try {
          const urls = returnUrls(input.returnUrl);
          const response = await callStripe('STRIPE_CREATE_CHECKOUT_SESSION', {
            mode: 'payment',
            client_reference_id: input.docket,
            metadata: { docket: input.docket, service: 'demand_letter_preparation' },
            success_url: urls.successUrl,
            cancel_url: urls.cancelUrl,
            line_items: [{
              quantity: 1,
              price_data: {
                currency: FILING_CURRENCY,
                unit_amount: FILING_FEE_CENTS,
                product_data: { name: FILING_ITEM_NAME },
              },
            }],
          });
          const session = findStripeSession(response);
          const checkoutSessionId = typeof session?.id === 'string' ? session.id : null;
          const checkoutUrl = typeof session?.url === 'string' ? session.url : null;
          if (!checkoutSessionId || !checkoutUrl) throw new Error('Hosted checkout did not return a secure URL.');
          const payment: PaymentRecord = {
            docket: input.docket,
            checkoutSessionId,
            checkoutUrl,
            status: 'pending',
            createdAt: new Date().toISOString(),
            verifiedAt: null,
          };
          await writeJson(ctx, paymentPath(input.docket), payment);
          return {
            ok: true as const,
            status: 'pending' as const,
            checkoutUrl,
            logSummary: `${input.docket}: hosted filing-fee checkout created.`,
            logData: { docket: input.docket },
          };
        } catch (error) {
          console.error('[payments.createCheckout] failed:', error);
          return { ok: false as const, reason: 'unavailable', logSummary: `${input.docket}: hosted checkout unavailable.` };
        }
      }),

    verifyCheckout: loggedProcedure
      .input(z.object({ docket: z.string().min(1).max(40), sessionId: z.string().startsWith('cs_').max(300) }))
      .mutation(async ({ input, ctx }) => {
        if (!isDocket(input.docket)) return { ok: false as const, reason: 'unknown_docket', logSummary: 'Payment verification declined: unknown docket.' };
        const payment = await readJson<PaymentRecord>(ctx, paymentPath(input.docket));
        if (!payment || payment.checkoutSessionId !== input.sessionId) {
          return { ok: false as const, reason: 'mismatch', logSummary: `${input.docket}: checkout does not match this filing.` };
        }
        console.log('[payments.verifyCheckout] requested:', { docket: input.docket });
        try {
          const response = await callStripe('STRIPE_RETRIEVE_CHECKOUT_SESSION', { session: input.sessionId });
          const session = findStripeSession(response);
          const metadata = asObject(session?.metadata);
          const paymentStatus = typeof session?.payment_status === 'string' ? session.payment_status : '';
          if (metadata?.docket !== input.docket || paymentStatus !== 'paid') {
            return { ok: true as const, status: 'pending' as const, logSummary: `${input.docket}: filing-fee payment is not verified yet.` };
          }
          await writeJson(ctx, paymentPath(input.docket), {
            ...payment,
            status: 'paid',
            verifiedAt: new Date().toISOString(),
          } satisfies PaymentRecord);
          return {
            ok: true as const,
            status: 'paid' as const,
            logSummary: `${input.docket}: filing-fee payment verified.`,
            logData: { docket: input.docket },
          };
        } catch (error) {
          console.error('[payments.verifyCheckout] failed:', error);
          return { ok: false as const, reason: 'unavailable', logSummary: `${input.docket}: payment verification unavailable.` };
        }
      }),
  });
}
