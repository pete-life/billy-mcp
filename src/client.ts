export type RecordData = Record<string, any>;
export const resources = {
  accounts: 'account', accountGroups: 'accountGroup', accountNatures: 'accountNature', contacts: 'contact', contactPersons: 'contactPerson', invoices: 'invoice', products: 'product', bills: 'bill',
  bankPayments: 'bankPayment', bankLines: 'bankLine', bankLineMatches: 'bankLineMatch', bankLineSubjectAssociations: 'bankLineSubjectAssociation',
  daybooks: 'daybook', daybookTransactions: 'daybookTransaction', postings: 'posting', taxRates: 'taxRate', salesTaxRulesets: 'salesTaxRuleset',
  attachments: 'attachment', files: 'file', salesTaxReturns: 'salesTaxReturn', transactions: 'transaction',
} as const;
export type Resource = keyof typeof resources;
export function id(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid Billy ID');
  return value;
}
export class BillyError extends Error {
  constructor(message: string, public status?: number) {super(message);}
}
export class BillyClient {
  constructor(private token: string, public organizationId: string, private fetcher: typeof fetch = fetch,
    private pause: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}
  private async request(method: string, path: string, body?: unknown, binary?: {bytes: Uint8Array; name: string; mime: string}): Promise<RecordData> {
    if (!this.token) throw new Error('Billy API token is not configured. Run setup locally; never paste secrets in chat.');
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`https://api.billysbilling.com/v2${path}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: {'X-Access-Token': this.token, 'Content-Type': binary?.mime || 'application/json',
            ...(binary ? {'X-Filename': encodeURIComponent(binary.name), 'X-Create-Attachment': 'true', 'X-OrganizationId': this.organizationId} : {})},
          body: binary ? Buffer.from(binary.bytes) : body === undefined ? undefined : JSON.stringify(body),
        });
      } catch { throw new BillyError(`Billy ${method} transport failed or timed out. ${method === 'GET' ? 'Read can be retried.' : 'Write outcome is unknown; inspect Billy before any new attempt.'}`); }
      if (method === 'GET' && [429, 502, 503, 504].includes(response.status) && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await this.pause(Math.min(5000, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 250 * 2 ** attempt));
        continue;
      }
      const raw = await response.text();
      let data: RecordData;
      try { data = JSON.parse(raw); } catch {throw new BillyError(`Billy returned non-JSON HTTP ${response.status}`, response.status);}
      if (!response.ok) {
        const detail = JSON.stringify(data).split(this.token).join('[REDACTED]').slice(0, 1500);
        throw new BillyError(`Billy HTTP ${response.status}: ${detail}`, response.status);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BillyError('Unexpected Billy response');
      return data;
    }
  }
  async organization() { const data = await this.request('GET', '/organization'); if (!data.organization?.id) throw new Error('Missing organization in Billy response'); return data.organization as RecordData; }
  async verifyOrganization() {
    if (!this.organizationId) throw new Error('BILLY_ORGANIZATION_ID must be resolved from the API token before accessing accounting data. Restart the server or run setup.');
    const org = await this.organization();
    if (org.id !== this.organizationId) throw new Error('Billy organization mismatch: refusing to access a different company.');
    return org;
  }
  async get(resource: Resource, recordId: string, include?: string): Promise<RecordData> {
    const query = new URLSearchParams(include ? {include} : {});
    const data = await this.request('GET', `/${resource}/${id(recordId)}?${query}`);
    const record = data[resources[resource]];
    if (!record || record.id !== recordId) throw new Error(`Unexpected ${resource} response`);
    if (record.organizationId && record.organizationId !== this.organizationId) throw new Error('Record belongs to a different organization');
    return record;
  }
  async list(resource: Resource, filters: Record<string, string | number | boolean> = {}, maxPages = 100): Promise<RecordData[]> {
    if (resource === 'bankLines' && !filters.accountId) throw new Error('bankLines requires accountId');
    const result: RecordData[] = [], seen = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      const query = new URLSearchParams(Object.entries({...filters, page, pageSize: 100}).map(([k,v]) => [k,String(v)]));
      const data = await this.request('GET', `/${resource}?${query}`);
      const items = data[resource];
      if (!Array.isArray(items)) throw new Error(`Missing ${resource} array`);
      for (const item of items) {
        if (!item?.id || seen.has(item.id)) throw new Error('Unstable pagination or duplicate IDs; refusing incomplete results');
        if (item.organizationId && item.organizationId !== this.organizationId) throw new Error('Cross-organization response');
        seen.add(item.id); result.push(item);
      }
      const paging = data.meta?.paging;
      if (paging) {
        if (!Number.isInteger(paging.pageCount) || paging.pageCount < 0) throw new Error('Invalid pagination metadata');
        if (page >= paging.pageCount) return result;
        if (!items.length) throw new Error('Empty intermediate page');
      } else if (items.length < 100) return result;
    }
    throw new Error(`Pagination exceeded ${maxPages} pages. Narrow the requested period; no partial results returned.`);
  }
  async write(resource: Resource, payload: RecordData, recordId?: string) {
    return this.request(recordId ? 'PUT' : 'POST', `/${resource}${recordId ? `/${id(recordId)}` : ''}`, {[resources[resource]]: payload});
  }
  async upload(bytes: Uint8Array, name: string, mime: string) {return this.request('POST', '/files', undefined, {bytes, name, mime});}
  // Billy documents invoice email delivery as this dedicated action, not an invoice update.
  async sendInvoiceEmail(invoiceId:string, contactPersonId:string, emailSubject:string, emailBody:string) {
    return this.request('POST', `/invoices/${id(invoiceId)}/emails`, {email:{contactPersonId:id(contactPersonId),emailSubject,emailBody}});
  }
}
