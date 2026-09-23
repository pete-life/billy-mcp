import type {Resource,RecordData} from './client.js';
import type {Plan} from './store.js';

// Explicit fields keep API additions, document bodies and signed links out of
// the default MCP context. Every record is retained; callers can opt into more
// fields without affecting the data used by Engine or Reports.
const common=['id','organizationId','name','entryDate','dueDate','createdTime','approvedTime','state','status','type',
  'currencyId','amount','grossAmount','tax','taxMode','balance','exchangeRate','isPaid','isVoided','isBankMatched','side','accountId','transactionId',
  'contactId','invoiceNo','suppliersInvoiceNo','voucherNo','systemRole','groupId','natureId','reportType',
  'normalBalance','accountNo','isArchived','isBankAccount','isReconciled','matchId','ownerReference',
  'fileId','attachmentId','bankLineId','subjectReference','modifierReference','taxRateId','quantity','unitPrice','rate',
  'text','source','reference'] as const;
const blockedKey=/password|passphrase|secret|token|credential|apiKey|accessCode|authorization|cookie|session|signed|downloadUrl|fileUrl/i;
function unsafeUrl(value:string){
  try{const url=new URL(value);return Boolean(url.username||url.password||url.search||url.hash||/(?:token|secret|accesscode|signed|signature)[=/]/i.test(url.pathname));}
  catch{return false;}
}
export function sanitizeText(value:string){
  return value.replace(/\b(?:access[_-]?code|api[_-]?key|token|password|secret|authorization)\b\s*["']?\s*[:=]\s*["']?[^\s,"'}]+/gi,'[redacted credential]')
    .replace(/\bBearer\s+\S+/gi,'[redacted credential]')
    .replace(/https?:\/\/[^\s"'<>]+/gi,url=>unsafeUrl(url)?'[redacted link]':url);
}

export function safeValue(value:unknown):unknown {
  if(Array.isArray(value))return value.map(safeValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key==='tokenConfigured'||!blockedKey.test(key)).map(([key,item])=>[key,safeValue(item)]));
  return typeof value==='string'?sanitizeText(value):value;
}

export function compactRecord(record:RecordData):RecordData {
  const result:RecordData={};
  for(const key of common)if(record[key]!==undefined&&!blockedKey.test(key))result[key]=record[key];
  if(Array.isArray(record.lines))result.lines=record.lines.map((line:RecordData)=>{
    const compact=compactRecord(line);
    if(typeof line.description==='string')compact.description=line.description;
    return compact;
  });
  for(const key of ['attachments','balanceModifiers','subjectAssociations'])if(Array.isArray(record[key]))result[key]=record[key].map(compactRecord);
  if(Array.isArray(record.candidatePostings))result.candidatePostings=record.candidatePostings.map((p:RecordData)=>({id:p.id,text:p.text,entryDate:p.entryDate}));
  return safeValue(result) as RecordData;
}

export function presentList(resource:Resource,records:RecordData[],verbose=false){
  return {resource,count:records.length,complete:true,records:verbose?safeValue(records):records.map(record=>{
    const compact=compactRecord(record);if(resource==='bankLines'&&typeof record.description==='string')compact.description=sanitizeText(record.description);
    return compact;
  })};
}
export function presentGet(resource:Resource,record:RecordData,verbose=false,include?:string){
  if(verbose)return {resource,complete:true,record:safeValue(record)};
  const compact=compactRecord(record);
  if(resource==='bankLines'&&typeof record.description==='string')compact.description=sanitizeText(record.description);
  for(const term of include?.split(',')??[]){
    const match=term.match(/^[A-Za-z]+\.([A-Za-z]+):embed$/);
    if(!match)continue;
    const key=match[1]!;
    if(compact[key]!==undefined)continue;
    if(record[key]&&typeof record[key]==='object')compact[key]=Array.isArray(record[key])?record[key].map(compactRecord):compactRecord(record[key]);
  }
  return {resource,complete:true,record:compact};
}
export function presentStatus(status:RecordData,verbose=false){
  if(verbose)return safeValue(status);
  return {tokenConfigured:status.tokenConfigured,organizationId:status.organizationId,writesEnabled:status.writesEnabled,
    bankMatchingEnabled:status.bankMatchingEnabled,receiptInbox:status.receiptInbox,dataDirectory:status.dataDirectory,
    organization:status.organization?compactRecord(status.organization):undefined};
}
export function presentOverview(overview:RecordData,verbose=false){
  if(verbose)return safeValue(overview);
  return {period:overview.period,complete:true,
    counts:{unreconciledBankLines:overview.unreconciledBankLines.length,bills:overview.bills.length,
      receipts:overview.receipts.length,vendors:overview.vendors.length},
    unreconciledBankLines:overview.unreconciledBankLines.map((line:RecordData)=>{
      const compact=compactRecord(line);if(typeof line.description==='string')compact.description=sanitizeText(line.description);return compact;
    }),bills:overview.bills.map(compactRecord),
    receipts:overview.receipts.map((r:RecordData)=>({id:r.id,name:r.name,attachmentId:r.attachmentId})),
    vendors:overview.vendors.map((v:RecordData)=>({id:v.id,name:v.name,status:v.status})),completion:overview.completion};
}
export function presentPlan(plan:Plan,verbose=false){
  if(verbose)return safeValue(plan);
  return {id:plan.id,hash:plan.hash,status:plan.status,createdAt:plan.createdAt,reason:sanitizeText(plan.reason),
    operation:safeValue(plan.operation),snapshots:plan.snapshots.map(s=>({resource:s.resource,id:s.id,hash:s.hash})),
    result:plan.result===undefined?undefined:safeValue(plan.result)};
}
