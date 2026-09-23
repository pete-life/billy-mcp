import {z} from 'zod';
import {BillyClient} from './client.js';
import {Engine} from './engine.js';
import {ApprovalGate} from './approval.js';
import {Store,digest,canonical,type Batch,type BatchLease,type Plan} from './store.js';
import {date,identifier,money,operation} from './schemas.js';

const positive=money.refine(value=>value>0);
const line=z.strictObject({accountId:identifier,taxRateId:identifier,description:z.string().min(1).max(1000),amount:positive});
const bill=z.strictObject({contactId:identifier,entryDate:date,currencyId:identifier,suppliersInvoiceNo:z.string().trim().min(1).max(160),taxMode:z.enum(['incl','excl']),lines:z.array(line).min(1).max(100)});
const payment=z.strictObject({entryDate:date,cashAmount:positive,cashSide:z.enum(['debit','credit']),cashAccountId:identifier,bankLineId:identifier,subjectAmount:positive.optional(),subjectCurrencyId:identifier.optional(),cashExchangeRate:z.number().finite().positive().optional(),feeAmount:positive.optional(),feeAccountId:identifier.optional()});
const purchase=z.strictObject({receiptId:z.string().regex(/^[a-f0-9]{64}$/),bill,approve:z.boolean(),payment:payment.optional(),reconcile:z.boolean().default(false)})
  .refine(value=>!value.payment||value.approve,'Payment requires approval of the bill')
  .refine(value=>!value.reconcile||Boolean(value.payment),'Reconciliation requires the payment stage');
export const purchaseBatch=z.strictObject({cases:z.array(purchase).min(1).max(10),reason:z.string().min(10).max(2000)})
  .refine(value=>new Set(value.cases.map(item=>item.receiptId)).size===value.cases.length,'Each receipt may appear only once in a batch')
  .refine(value=>new Set(value.cases.map(item=>`${item.bill.contactId}:${item.bill.suppliersInvoiceNo.trim().toLowerCase()}`)).size===value.cases.length,'Duplicate supplier invoice in batch')
  .refine(value=>{const lines=value.cases.flatMap(item=>item.payment?[item.payment.bankLineId]:[]);return new Set(lines).size===lines.length;},'One bank line cannot pay two cases in a batch');
export type PurchaseBatch=z.infer<typeof purchaseBatch>;
type Snapshot={receipt:{id:string;metadataHash:string;attachmentId?:string};records:Array<{resource:string;id:string;hash:string}>};
const cents=(value:number)=>Math.round(value*100);
const normalize=(value:unknown)=>String(value??'').trim().toLowerCase().replace(/\s+/g,' ');
function materialRecord(resource:string,record:any){
  if(resource==='contacts')return {id:record.id,name:record.name,countryId:record.countryId,registrationNo:record.registrationNo,vatNo:record.vatNo,isSupplier:record.isSupplier};
  if(resource==='accounts')return {id:record.id,isArchived:record.isArchived,isPaymentEnabled:record.isPaymentEnabled,currencyId:record.currencyId,systemRole:record.systemRole};
  if(resource==='bankLines')return {id:record.id,accountId:record.accountId,entryDate:record.entryDate,side:record.side,amount:record.amount,isReconciled:record.isReconciled,matchId:record.matchId};
  if(resource==='bankLineMatches')return {id:record.id,isApproved:record.isApproved,lines:record.lines,subjectAssociations:record.subjectAssociations};
  return record;
}
function billFinancial(record:any){
  if(!record||typeof record.id!=='string'||!Array.isArray(record.lines)||!record.lines.length||!Number.isFinite(Number(record.amount))||!Number.isFinite(Number(record.tax)))throw new Error('Bill financial identity or embedded lines are unavailable; approval stopped');
  const lines=record.lines.map((line:any)=>{
    if(typeof line.accountId!=='string'||typeof line.taxRateId!=='string'||typeof line.description!=='string'||!Number.isFinite(Number(line.amount))||!Number.isFinite(Number(line.tax)))throw new Error('Bill line identity is incomplete; approval stopped');
    return {accountId:line.accountId,taxRateId:line.taxRateId,description:line.description,amountCents:cents(Number(line.amount)),taxCents:cents(Number(line.tax))};
  }).sort((a:any,b:any)=>canonical(a).localeCompare(canonical(b)));
  return {id:record.id,contactId:record.contactId,entryDate:record.entryDate,currencyId:record.currencyId,suppliersInvoiceNo:record.suppliersInvoiceNo,taxMode:record.taxMode,amountCents:cents(Number(record.amount)),taxCents:cents(Number(record.tax)),lines};
}

export class BatchManager {
  constructor(private client:BillyClient,private engine:Engine,private store:Store,private approval:ApprovalGate){}
  private publicView(batch:Batch){
    const stages=Object.fromEntries(Object.entries(batch.stages).map(([key,stage])=>{
      const plan=this.store.plan(stage.planId),result=plan.result;
      const summary=plan.status==='completed'?{
        ...(result?.id?{recordId:result.id}:{}),
        ...(result?.attachment?.id?{attachmentId:result.attachment.id}:{}),
        ...(result?.payment?.id?{paymentId:result.payment.id}:{}),
        ...(result?.subject?.id?{subjectId:result.subject.id}:{}),
        ...(result?.match?.id?{matchId:result.match.id}:{}),
        ...(result?.posting?.id?{postingId:result.posting.id}:{}),
      }:(result?.error?{error:String(result.error)}:{});
      return [key,{planId:stage.planId,hash:plan.hash,status:plan.status,...summary}];
    }));
    return {id:batch.id,hash:batch.hash,intent:batch.intent,spec:batch.spec,initialEvidenceHash:digest(batch.snapshots),createdAt:batch.createdAt,status:batch.status,stages,approval:batch.approval,error:batch.error};
  }
  private async preflightCase(item:PurchaseBatch['cases'][number],checkDuplicate=true):Promise<Snapshot>{
    operation.parse({kind:'create_bill',receiptId:item.receiptId,...item.bill});
    if(item.payment)operation.parse({kind:'create_payment',...item.payment,subjectReference:'bill:pending'});
    if(item.reconcile){
      if(!this.engine.config.bankMatching)throw new Error('Bank matching is disabled for this profile');
      operation.parse({kind:'reconcile',bankLineId:item.payment!.bankLineId,subjectReference:'posting:pending'});
    }
    const receipt=this.store.receiptBytes(item.receiptId).receipt;
    const metadata=receipt.metadata,expected=item.bill;
    if(metadata.invoiceNumber!==expected.suppliersInvoiceNo||metadata.invoiceDate!==expected.entryDate||metadata.currencyId!==expected.currencyId)throw new Error('Purchase case does not match receipt invoice number, date or currency');
    const amount=expected.lines.reduce((total,l)=>total+cents(l.amount),0);
    if(amount!==cents(expected.taxMode==='incl'?metadata.totalAmount:metadata.netAmount)||cents(metadata.netAmount)+cents(metadata.vatAmount)!==cents(metadata.totalAmount))throw new Error('Purchase lines do not match receipt net/VAT/gross evidence');
    const records:Snapshot['records']=[];
    const get=async(resource:'contacts'|'accounts'|'taxRates'|'bankLines'|'bankLineMatches',id:string,include?:string)=>{
      const record=await this.client.get(resource,id,include);records.push({resource,id,hash:digest(materialRecord(resource,record))});return record;
    };
    const contact=await get('contacts',expected.contactId);
    if(!contact.isSupplier)throw new Error('Selected contact is not a supplier');
    if(metadata.supplierRegistrationNo){
      const country=metadata.supplierCountryId;
      const normalized=(value:unknown)=>String(value??'').toUpperCase().replace(/[\s.-]/g,'').replace(new RegExp(`^${country}`),'');
      if(!country||contact.countryId!==country||![contact.registrationNo,contact.vatNo].some(value=>normalized(value)===normalized(metadata.supplierRegistrationNo)))throw new Error('Receipt registration identity does not match supplier contact');
    }else if(normalize(contact.name)!==normalize(metadata.supplier))throw new Error('Receipt supplier name does not match contact');
    for(const accountId of new Set(expected.lines.map(l=>l.accountId))){const account=await get('accounts',accountId);if(account.isArchived)throw new Error('Purchase uses an archived account');}
    for(const taxRateId of new Set(expected.lines.map(l=>l.taxRateId))){const tax=await get('taxRates',taxRateId);if(tax.isActive===false||tax.appliesToPurchases===false)throw new Error('Purchase uses an inactive or non-purchase tax rate');}
    if(item.payment){
      const cash=await get('accounts',item.payment.cashAccountId);
      if(cash.isArchived||!cash.isPaymentEnabled)throw new Error('Payment account is not active for payments');
      if(item.payment.feeAmount!==undefined){
        const organization=await this.client.verifyOrganization();
        if(!item.payment.feeAccountId||organization.defaultBankFeeAccountId!==item.payment.feeAccountId||item.payment.feeAccountId===item.payment.cashAccountId)throw new Error('Payment fee account must match the configured bank fee expense account');
        const fee=await get('accounts',item.payment.feeAccountId);
        if(fee.isArchived)throw new Error('Payment fee expense account is archived');
      }
      const bank=await get('bankLines',item.payment.bankLineId);
      if(bank.isReconciled||bank.accountId!==item.payment.cashAccountId||bank.entryDate!==item.payment.entryDate||bank.side!==item.payment.cashSide||cents(Number(bank.amount))!==cents(item.payment.cashAmount))throw new Error('Payment does not match the exact unreconciled bank line');
      if(!bank.matchId)throw new Error('Payment bank line has no match');
      const match=await get('bankLineMatches',bank.matchId,'bankLineMatch.lines:embed,bankLineMatch.subjectAssociations:embed');
      if(match.isApproved!==false||!Array.isArray(match.lines)||match.lines.length!==1||match.lines[0].id!==bank.id||!Array.isArray(match.subjectAssociations)||match.subjectAssociations.length)throw new Error('Payment requires an inspectable, unapproved single-line bank match without associations');
    }
    if(checkDuplicate){
      const bills=await this.client.list('bills',{suppliersInvoiceNo:expected.suppliersInvoiceNo});
      if(bills.some(existing=>existing.contactId===expected.contactId&&normalize(existing.suppliersInvoiceNo)===normalize(expected.suppliersInvoiceNo)))throw new Error('Supplier invoice already exists in Billy');
    }
    return {receipt:{id:receipt.id,metadataHash:digest(metadata),...(receipt.attachmentId?{attachmentId:receipt.attachmentId}:{})},records};
  }
  private async snapshots(spec:PurchaseBatch):Promise<Snapshot[]>{
    await this.client.verifyOrganization();
    const result:Snapshot[]=[];for(const item of spec.cases)result.push(await this.preflightCase(item));return result;
  }
  async prepare(input:unknown){
    const spec=purchaseBatch.parse(input);
    return this.publicView(this.store.prepareBatch(spec,await this.snapshots(spec)));
  }
  async refresh(batchId:string){
    const current=this.store.batch(batchId),spec=purchaseBatch.parse(current.spec);
    return this.publicView(this.store.refreshBatch(batchId,await this.snapshots(spec)));
  }
  get(batchId:string){return this.publicView(this.store.batch(batchId));}
  private completed(batch:Batch,key:string){const stage=batch.stages[key];return Boolean(stage&&this.store.plan(stage.planId).status==='completed');}
  private async verifyPending(batch:Batch){
    const spec=purchaseBatch.parse(batch.spec);
    await this.client.verifyOrganization();
    for(let i=0;i<spec.cases.length;i++){
      const item=spec.cases[i]!,expected=batch.snapshots[i] as Snapshot;
      const terminal=item.reconcile?'reconcile':item.payment?'payment':item.approve?'approve':'bill';
      if(batch.stages[`${i}:final`]||this.completed(batch,`${i}:${terminal}`))continue;
      const current=await this.preflightCase(item,!this.completed(batch,`${i}:bill`));
      const upload=batch.stages[`${i}:upload`];
      const allowed:Snapshot=structuredClone(expected);
      if(upload&&this.completed(batch,`${i}:upload`)){
        const plan=this.store.plan(upload.planId);
        allowed.receipt.attachmentId=plan.result?.attachment?.id;
        if(!allowed.receipt.attachmentId)throw new Error('Completed upload has no attachment ID');
      }
      if(digest(current)!==digest(allowed))throw new Error(`Batch case ${i+1} initial evidence changed; refresh before any writes, or create a new batch for remaining cases.`);
    }
  }
  private async stage(lease:BatchLease,key:string,op:unknown,reason:string,validatePlan?:(plan:Plan)=>void){
    const existing=this.store.batch(lease.batchId).stages[key];
    let plan;
    if(existing){plan=this.store.plan(existing.planId);if(plan.hash!==existing.hash)throw new Error('Saved stage plan hash changed; review before resuming');}
    else{
      plan=await this.engine.prepare(operation.parse(op),reason);
      this.store.saveBatchStage(lease,key,{planId:plan.id,hash:plan.hash,status:plan.status==='completed'?'completed':'prepared'});
    }
    if(plan.status==='completed'){this.store.saveBatchStage(lease,key,{planId:plan.id,hash:plan.hash,status:'completed'});return plan;}
    if(plan.status==='rejected'){
      const refreshed=await this.engine.refresh(plan.id);
      if(refreshed.hash!==plan.hash&&existing)throw new Error(`Batch stage ${key} changed after rejection; refresh the unstarted batch or create a new batch for remaining cases and obtain new approval.`);
      if(refreshed.hash!==plan.hash)this.store.saveBatchStage(lease,key,{planId:refreshed.id,hash:refreshed.hash,status:'prepared'});
      plan=refreshed;
    }
    if(plan.status!=='prepared')throw new Error(`Batch stage ${key} is ${plan.status}; inspect Billy and the journal before continuing.`);
    validatePlan?.(plan);
    const result=await this.engine.execute(plan.id,plan.hash,lease);
    this.store.saveBatchStage(lease,key,{planId:plan.id,hash:plan.hash,status:'completed'});
    return result;
  }
  async execute(batchId:string,expectedHash:string,authorization:string){
    const batch=this.store.batch(batchId);
    if(batch.hash!==expectedHash)throw new Error('Batch hash mismatch');
    if(batch.status==='completed')return this.publicView(batch);
    await this.verifyPending(batch);
    const mode=this.engine.config.approvalMode||'confirm';
    if(batch.approval?.scopeHash!==batch.hash||batch.approval.mode!==mode){
      const evidence=await this.approval.authorize({companyId:this.store.organizationId,hash:batch.hash,details:batch.spec,authorization});
      this.store.approveBatch(batch.id,batch.hash,evidence);
    }
    await this.verifyPending(this.store.batch(batchId));
    const lease=this.store.claimBatch(batchId,expectedHash);
    try{
      const spec=purchaseBatch.parse(batch.spec);
      for(let i=0;i<spec.cases.length;i++){
        if(this.store.batch(batchId).stages[`${i}:final`])continue;
        const item=spec.cases[i]!,reason=`Batch ${batchId} case ${i+1}: ${spec.reason}`;
        await this.verifyPending(this.store.batch(batchId));
        const receipt=this.store.receipt(item.receiptId);
        if(!receipt.attachmentId||this.store.batch(batchId).stages[`${i}:upload`])await this.stage(lease,`${i}:upload`,{kind:'upload_receipt',receiptId:item.receiptId},reason);
        await this.verifyPending(this.store.batch(batchId));
        const billPlan=await this.stage(lease,`${i}:bill`,{kind:'create_bill',receiptId:item.receiptId,...item.bill},reason);
        const billId=billPlan.result?.id;
        if(typeof billId!=='string')throw new Error('Completed bill stage has no verified bill ID');
        const created=billFinancial(billPlan.result);
        const metadata=this.store.receipt(item.receiptId).metadata;
        const expectedLines=item.bill.lines.map(line=>({accountId:line.accountId,taxRateId:line.taxRateId,description:line.description,amountCents:cents(line.amount)})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
        const enteredLines=created.lines.map(({taxCents,...line}:any)=>({...line,amountCents:line.amountCents+(item.bill.taxMode==='incl'?taxCents:0)})).sort((a:any,b:any)=>canonical(a).localeCompare(canonical(b)));
        if(created.contactId!==item.bill.contactId||created.entryDate!==item.bill.entryDate||created.currencyId!==item.bill.currencyId||created.suppliersInvoiceNo!==item.bill.suppliersInvoiceNo||created.taxMode!==item.bill.taxMode||created.amountCents!==cents(metadata.netAmount)||created.taxCents!==cents(metadata.vatAmount)||digest(enteredLines)!==digest(expectedLines))throw new Error('Created bill financial identity differs from the approved purchase case');
        await this.verifyPending(this.store.batch(batchId));
        if(item.approve)await this.stage(lease,`${i}:approve`,{kind:'approve',resource:'bills',id:billId},reason,plan=>{
          const snapshot=plan.snapshots.find((entry:any)=>entry.resource==='bills'&&entry.id===billId);
          if(!snapshot||digest(billFinancial(snapshot.record))!==digest(created))throw new Error('Approval plan bill identity or lines differ from the batch-created bill; approval stopped');
        });
        if(item.payment){
          await this.verifyPending(this.store.batch(batchId));
          const paymentPlan=await this.stage(lease,`${i}:payment`,{kind:'create_payment',...item.payment,subjectReference:`bill:${billId}`},reason);
          if(item.reconcile){
            await this.verifyPending(this.store.batch(batchId));
            const {postingId,bankLineId}=await this.engine.resolvePaymentCashPosting(paymentPlan.id);
            if(bankLineId!==item.payment.bankLineId)throw new Error('Payment posting resolver returned a different bank line');
            await this.stage(lease,`${i}:reconcile`,{kind:'reconcile',bankLineId,subjectReference:`posting:${postingId}`},reason);
          }
        }
        this.store.saveBatchStage(lease,`${i}:final`,{planId:billPlan.id,hash:billPlan.hash,status:'completed'});
      }
      return this.publicView(this.store.finishBatch(lease,'completed'));
    }catch(error){
      const message=error instanceof Error?error.message:'Batch stage failed';
      const partial=this.store.finishBatch(lease,'paused',message);
      return {stopped:true,error:message,batch:this.publicView(partial)};
    }
  }
}
