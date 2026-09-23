import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {BillyClient,resources,type Resource} from './client.js';
import {Store} from './store.js';
import {Engine} from './engine.js';
import {Reports} from './reports.js';
import {presentGet,presentList,presentOverview,presentPlan,presentStatus,compactRecord,safeValue,sanitizeText} from './presentation.js';
import {ApprovalGate} from './approval.js';
import {BatchManager,purchaseBatch} from './batches.js';
import {date,identifier,operation,receiptMetadata,sanitizeSource,source} from './schemas.js';
import type {Config} from './config.js';

const filters:Record<Resource,string[]>={
  accounts:['isBankAccount','isArchived','systemRole'], accountGroups:[],accountNatures:[],contacts:['isCustomer','isSupplier'],contactPersons:[],
  invoices:['contactId','state','isPaid','minEntryDate','maxEntryDate','invoiceNo','currencyId','q'],
  bills:['contactId','state','isPaid','minEntryDate','maxEntryDate','hasAttachments','suppliersInvoiceNo','currencyId','q'],
  bankLines:['accountId','isReconciled','status','side','receiptState','minEntryDate','maxEntryDate','minAmount','maxAmount','q'],
  postings:['accountId','transactionId','minEntryDate','maxEntryDate','isVoided','isBankMatched','q'],
  attachments:['ownerReference','unhandled','type','supplier','amount','isDuplicate','q'],
  daybookTransactions:['daybookId','state','minEntryDate','maxEntryDate','q'],
  bankPayments:[],bankLineMatches:[],bankLineSubjectAssociations:[],daybooks:[],taxRates:[],salesTaxRulesets:[],files:[],salesTaxReturns:[],transactions:[],products:['isArchived'],
};
export function createServer(config:Config,client=new BillyClient(config.token,config.organizationId),store=new Store(config.dataDir,config.inbox,config.organizationId)) {
  const server=new McpServer({name:'billy-mcp',version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version});
  const engine=new Engine(client,store,config);
  const reports=new Reports(client);
  const approvalGate=new ApprovalGate(config,server);
  const batches=new BatchManager(client,engine,store,approvalGate);
  function tool(name:string,description:string,schema:any,mutates:boolean,handler:(args:any)=>Promise<any>|any) {
    server.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:!mutates,destructiveHint:mutates,idempotentHint:!mutates,openWorldHint:true}},async(args:any)=>{
      try{
        if(name!=='billy_status'&&!config.organizationId)throw new Error('Connect a company API token first; organization is discovered automatically at startup.');
        const result=await handler(args);
        return {content:[{type:'text' as const,text:JSON.stringify(safeValue(result),null,2)}]};
      }catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof Error?sanitizeText(e.message):'Operation failed'}]};}
    });
  }
  tool('billy_status','Configuration and connection status. Never exposes credentials.',{verbose:z.boolean().default(false)},false,async({verbose})=>{
    const status={tokenConfigured:Boolean(config.token),organizationId:config.organizationId||null,writesEnabled:config.writes,bankMatchingEnabled:config.bankMatching,approvalMode:config.approvalMode||'confirm',receiptInbox:config.inbox,dataDirectory:config.dataDir};
    return presentStatus(config.token&&config.organizationId?{...status,organization:await client.verifyOrganization()}:status,verbose);
  });
  tool('billy_list','List every page of a Billy resource. Default response is compact and complete; verbose returns sanitized detail. Unknown filters are rejected.',{
    resource:z.enum(Object.keys(resources) as [Resource,...Resource[]]),filters:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).default({}),
    verbose:z.boolean().default(false),
  },false,async({resource,filters:query,verbose})=>{
    await client.verifyOrganization();
    const allowed=filters[resource as Resource]??[];
    for(const key of Object.keys(query))if(!allowed.includes(key))throw new Error(`Unsupported filter ${key} for ${resource}; allowed: ${allowed.join(', ')}`);
    return presentList(resource,await client.list(resource,query),verbose);
  });
  tool('billy_get','Read a Billy record and optionally sideload relationships. Default response is compact; verbose returns sanitized detail.',{resource:z.enum(Object.keys(resources) as [Resource,...Resource[]]),id:identifier,include:z.string().regex(/^[A-Za-z.,:]+$/).optional(),verbose:z.boolean().default(false)},false,
    async({resource,id,include,verbose})=>{await client.verifyOrganization();return presentGet(resource,await client.get(resource,id,include),verbose,include);});
  tool('billy_period_overview','Inventory unreconciled bank lines, existing postings, bills and collected receipts for a period. Candidate matches are suggestions, not an accounting verdict.',{start:date,end:date,verbose:z.boolean().default(false)},false,
    async({start,end,verbose})=>presentOverview(await engine.overview(start,end),verbose));
  tool('billy_trial_balance','Balances by live account through an inclusive posting entry date. Uses base currency and rejects FX postings without a base amount.',
    {asOf:date,includeZero:z.boolean().default(false),accountIds:z.array(identifier).optional()},false,
    ({asOf,includeZero,accountIds})=>reports.trialBalance(asOf,includeZero,accountIds));
  tool('billy_profit_loss','Period P&L from non-voided postings. Defaults to live incomeStatement account natures, or accepts explicit reportType or revenue and expense account IDs; no chart numbers are assumed.',
    {start:date,end:date,reportType:z.string().min(1).max(100).optional(),revenueAccountIds:z.array(identifier).optional(),expenseAccountIds:z.array(identifier).optional(),verbose:z.boolean().default(false)},false,
    ({start,end,reportType,revenueAccountIds,expenseAccountIds,verbose})=>reports.profitLoss(start,end,{reportType,revenueAccountIds,expenseAccountIds},verbose));
  tool('billy_outstanding','Current approved unpaid bills and invoices, grouped by original currency. Not a historical as-of report.',{},false,()=>reports.outstanding());
  tool('billy_period_expenses','Net expense postings on debit-normal accounts under a live account-nature reportType (default incomeStatement), optionally narrowed to selected expense account IDs; credits reduce expense.',
    {start:date,end:date,reportType:z.string().min(1).max(100).default('incomeStatement'),accountIds:z.array(identifier).min(1).optional(),verbose:z.boolean().default(false)},false,
    ({start,end,reportType,accountIds,verbose})=>reports.periodExpenses(start,end,reportType,accountIds,verbose));
  tool('billy_import_receipt','Archive an original PDF/PNG/JPEG from the configured inbox. Provide extracted invoice metadata and provenance from Gmail, Drive, local files or vendor portal. Same bytes are deduplicated. Does not upload to Billy.',
    {filePath:z.string().min(1),source,metadata:receiptMetadata},true,({filePath,source:origin,metadata})=>{
      if(origin.kind==='vendor_portal'){
        const vendor=store.vendors().find(v=>v.id===origin.vendorId);
        if(!vendor||new URL(vendor.portalUrl).origin!==new URL(origin.reference).origin)throw new Error('Vendor receipt requires a registered vendorId and matching portal origin');
      }
      return store.importReceipt(filePath,sanitizeSource(origin),metadata);
    });
  tool('billy_receipts','List locally archived supporting documents and their Billy attachment IDs.',{verbose:z.boolean().default(false)},false,({verbose})=>{
    const receipts=store.receipts();return {count:receipts.length,complete:true,receipts:verbose?safeValue(receipts):receipts.map(r=>({id:r.id,name:r.name,attachmentId:r.attachmentId}))};
  });
  tool('billy_save_vendor','Store a vendor billing portal location and retrieval status. This registry guides the agent browser/connector; it does not log in itself. Never include secrets or session URLs.',{
    id:identifier,name:z.string().min(1).max(200),portalUrl:z.url(),accountLabel:z.string().min(1).max(200),
    status:z.enum(['ready','needs_login','needs_2fa','not_accessible','not_checked']),notes:z.string().max(1000).default(''),
  },true,args=>{
    const url=new URL(args.portalUrl);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Use a clean HTTPS billing portal URL without credentials, query or fragment');
    return store.vendor({...args,portalUrl:url.toString(),updatedAt:new Date().toISOString()});
  });
  tool('billy_vendors','List vendor billing portals and access exceptions for receipt retrieval.',{verbose:z.boolean().default(false)},false,({verbose})=>{
    const vendors=store.vendors();return {count:vendors.length,complete:true,vendors:verbose?safeValue(vendors):vendors.map(compactRecord)};
  });
  tool('billy_prepare','Validate and persist a concrete write proposal without modifying Billy. Review the returned operation, reason, ID and hash. Receipts must be uploaded before preparing a booking. Reconciliation is restricted to matching existing bank-account postings.',{
    operation,reason:z.string().min(10).max(2000),verbose:z.boolean().default(false),
  },true,async({operation:op,reason,verbose})=>presentPlan(await engine.prepare(op,reason),verbose));
  tool('billy_plan','Inspect a saved proposal and its execution evidence. Default output retains operation, hash and snapshot hashes.',{planId:z.uuid(),verbose:z.boolean().default(false)},false,({planId,verbose})=>presentPlan(store.plan(planId),verbose));
  tool('billy_refresh_plan','Refresh an unexecuted/rejected proposal after changed data or expiry; review it again before execution.',{planId:z.uuid(),verbose:z.boolean().default(false)},true,async({planId,verbose})=>presentPlan(await engine.refresh(planId),verbose));
  tool('billy_execute','Execute the exact reviewed proposal once. Default approval uses the MCP client form; a supplied authorization note is only an audit assertion. Unknown outcomes block further writes.',{
    planId:z.uuid(),expectedHash:z.string().regex(/^[a-f0-9]{64}$/),authorization:z.string().min(10).max(1000),
  },true,async({planId,expectedHash,authorization})=>{
    const plan=store.plan(planId);
    if(plan.hash!==expectedHash)throw new Error('Plan hash mismatch');
    if(plan.status==='completed')return presentPlan(plan);
    const approval=await approvalGate.authorize({companyId:config.organizationId,hash:expectedHash,details:{operation:plan.operation,reason:plan.reason},authorization});
    store.event(planId,`approval: ${JSON.stringify(approval)}; authorization: ${authorization}`);
    return presentPlan(await engine.execute(planId,expectedHash));
  });
  tool('billy_batch_prepare','Preflight and save an ordered purchase batch (1-10 cases). Each case binds an original receipt, exact draft lines and explicit approval/payment/reconciliation stages. No Billy writes.',
    {cases:purchaseBatch.shape.cases,reason:purchaseBatch.shape.reason},true,args=>batches.prepare(args));
  tool('billy_batch_get','Inspect saved batch, child plan IDs, partial progress and stop reason.',{batchId:z.uuid()},false,({batchId})=>batches.get(batchId));
  tool('billy_batch_refresh','Refresh initial evidence for a batch before any stage starts; clears prior client approval.',{batchId:z.uuid()},true,({batchId})=>batches.refresh(batchId));
  tool('billy_batch_execute','Approve the complete ordered company batch once and execute its stages sequentially through guarded plans. A stop returns explicit partial progress. Resume the same hash after inspecting the cause.',
    {batchId:z.uuid(),expectedHash:z.string().regex(/^[a-f0-9]{64}$/),authorization:z.string().min(10).max(1000)},true,
    ({batchId,expectedHash,authorization})=>batches.execute(batchId,expectedHash,authorization));
  tool('billy_journal','Read the last 200 proposals, including rejected/uncertain writes. An unknown outcome requires reconciliation against live Billy records before recovery.',{verbose:z.boolean().default(false)},false,({verbose})=>{
    const plans=store.plans();return {count:plans.length,limit:200,completeWithinLimit:plans.length<200,plans:plans.map(p=>presentPlan(p,verbose))};
  });
  server.registerPrompt('bookkeeping-period',{description:'Bookkeeping workflow: gather receipts from mail/files/vendor accounts, propose bookings, reconcile and verify.',argsSchema:{start:date,end:date}},({start,end})=>({messages:[{role:'user',content:{type:'text',text:`Get the connected company’s bookkeeping ready for ${start} through ${end}.\nSkill directory (resolve its relative references here): ${fileURLToPath(new URL('../skills/billy-bookkeeping/',import.meta.url))}\n\n${readFileSync(new URL('../skills/billy-bookkeeping/SKILL.md',import.meta.url),'utf8')}`}}]}));
  return {server,engine,store};
}
