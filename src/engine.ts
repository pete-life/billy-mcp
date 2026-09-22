import {BillyClient, BillyError, type Resource, type RecordData, resources} from './client.js';
import {Store, digest, type Plan} from './store.js';
import {operation, type Operation} from './schemas.js';
import type {Config} from './config.js';

const cents=(v:number)=>Math.round(v*100);
const normalize=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
const numeric=(value:unknown)=>Number(value);
const currencyOf=(record:RecordData)=>typeof record.currencyId==='string'?record.currencyId:
  (record.currency&&typeof record.currency.id==='string'?record.currency.id:undefined);
const close=(actual:unknown,expected:number,tolerance=0.0001)=>Number.isFinite(numeric(actual))&&Math.abs(numeric(actual)-expected)<=tolerance;
const subjectInclude=(resource:Resource)=>resource==='bills'?'bill.balanceModifiers:embed':resource==='invoices'?'invoice.balanceModifiers:embed':undefined;
const associationSubject=(association:RecordData)=>association.subjectReference||association.subject?.reference||association.subject?.id;
const associationModifier=(association:RecordData)=>association.modifierReference||association.modifier?.reference||association.modifier?.id;
const originatorOf=(record:RecordData)=>record.originatorReference||record.originator?.reference||record.originator?.id||record.originator;
const accountReference=(record:RecordData)=>record.accountId||record.account?.id;
function ledgerAccounts(snapshots:{resource:Resource;id:string;hash:string;record:RecordData}[]) {
  const accounts=snapshots.filter(snapshot=>snapshot.resource==='accounts').map(snapshot=>snapshot.record);
  return {payable:accounts.find(account=>account.systemRole==='accountsPayable'),fx:accounts.find(account=>account.systemRole==='realizedCurrencyDifference')};
}
function supplierMatches(contact:RecordData,metadata:RecordData) {
  if(metadata.supplierRegistrationNo){
    if(!metadata.supplierCountryId||contact.countryId!==metadata.supplierCountryId)return false;
    const normalized=(value:unknown)=>String(value??'').toUpperCase().replace(/[\s.-]/g,'').replace(new RegExp(`^${metadata.supplierCountryId}`),'');
    const expected=normalized(metadata.supplierRegistrationNo);
    return Boolean(expected)&&[contact.registrationNo,contact.vatNo].some(value=>normalized(value)===expected);
  }
  return normalize(contact.name)===normalize(metadata.supplier);
}
function assertMoney(actual:unknown, expected:number, name:string) {
  if(actual===null||actual===''||!Number.isFinite(Number(actual))||cents(Number(actual))!==cents(expected))throw new Error(`Read-back ${name} does not match the supporting document`);
}
function verifyBill(actual:RecordData,metadata:RecordData) {
  assertMoney(actual.amount,metadata.netAmount,'net amount');
  assertMoney(actual.tax,metadata.vatAmount,'VAT');
  assertMoney(Number(actual.amount)+Number(actual.tax),metadata.totalAmount,'gross total');
  if(actual.entryDate!==metadata.invoiceDate||actual.currencyId!==metadata.currencyId||actual.suppliersInvoiceNo!==metadata.invoiceNumber)throw new Error('Bill date, currency or invoice number differs from supporting document');
}
function verifyLines(actual:RecordData, expected:RecordData[]) {
  if(!Array.isArray(actual.lines)||actual.lines.length!==expected.length)throw new Error('Read-back journal lines are missing or changed');
  const remaining=[...actual.lines];
  for(const line of expected){
    const index=remaining.findIndex(candidate=>Object.entries(line).every(([key,value])=>key==='amount'?Number.isFinite(Number(candidate[key]))&&cents(Number(candidate[key]))===cents(value):candidate[key]===value));
    if(index<0)throw new Error('Read-back journal account, amount, direction, currency or text differs');remaining.splice(index,1);
  }
}
function subject(ref:string): {resource:Resource; id:string} {
  const [kind, recordId]=ref.split(':');
  const resource=Object.entries(resources).find(([,single])=>single===kind)?.[0] as Resource|undefined;
  if(!resource||!recordId)throw new Error('Unsupported reference');return {resource,id:recordId};
}
export class Engine {
  constructor(public client:BillyClient,public store:Store,public config:Config){}
  private async inspect(op:Operation) {
    const organization=await this.client.verifyOrganization();
    const snapshots:{resource:Resource;id:string;hash:string;record:RecordData}[]=[];
    const get=async(resource:Resource,id:string,include?:string)=>{
      const record=await this.client.get(resource,id,include);
      snapshots.push({resource,id,hash:digest(record),record});return record;
    };
    const account=async(recordId:string)=>{const a=await get('accounts',recordId);if(a.isArchived)throw new Error('Archived account');return a;};
    const receipt=(receiptId:string)=>{
      const r=this.store.receiptBytes(receiptId).receipt;
      if(!r.attachmentId)throw new Error('Upload this receipt first, then prepare the booking');return r;
    };
    switch(op.kind){
      case 'upload_receipt': {
        const r=this.store.receiptBytes(op.receiptId).receipt;
        if(r.attachmentId)throw new Error(`Receipt already uploaded as attachment ${r.attachmentId}`);break;
      }
      case 'create_contact': {
        const contacts=await this.client.list('contacts');
        if(contacts.some(c=>(op.registrationNo&&c.registrationNo===op.registrationNo)||String(c.name).trim().toLowerCase()===op.name.toLowerCase()))throw new Error('A matching contact already exists; use it instead');break;
      }
      case 'create_bill': {
        const r=receipt(op.receiptId), contact=await get('contacts',op.contactId);
        if(!contact.isSupplier)throw new Error('Contact is not a supplier');
        if(!supplierMatches(contact,r.metadata))throw new Error('Receipt supplier does not match selected contact identity; verify name or country and registration number');
        if(r.metadata.invoiceNumber!==op.suppliersInvoiceNo||r.metadata.invoiceDate!==op.entryDate||r.metadata.currencyId!==op.currencyId)throw new Error('Bill does not match the receipt invoice number, date or currency');
        const sum=op.lines.reduce((n,l)=>n+cents(l.amount),0);
        if(sum!==cents(op.taxMode==='incl'?r.metadata.totalAmount:r.metadata.netAmount))throw new Error('Bill line amounts do not match receipt');
        const contacts=await this.client.list('contacts');
        const aliases=new Set(contacts.filter(c=>normalize(c.name)===normalize(contact.name)||(contact.registrationNo&&c.registrationNo===contact.registrationNo)).map(c=>c.id));aliases.add(op.contactId);
        const bills=await this.client.list('bills',{suppliersInvoiceNo:op.suppliersInvoiceNo});
        if(bills.some(b=>aliases.has(b.contactId)&&normalize(b.suppliersInvoiceNo)===normalize(op.suppliersInvoiceNo)))throw new Error('Supplier invoice already exists in Billy');
        const sameDate=await this.client.list('bills',{minEntryDate:op.entryDate,maxEntryDate:op.entryDate});
        if(sameDate.some(b=>aliases.has(b.contactId)&&b.entryDate===op.entryDate&&b.currencyId===op.currencyId&&cents(Number(b.amount)+Number(b.tax))===cents(r.metadata.totalAmount)))throw new Error('Possible duplicate purchase on same date/amount, including records without invoice number; resolve in Billy first');
        const attachment=await get('attachments',r.attachmentId!);
        if(attachment.ownerReference)throw new Error('Receipt already belongs to another Billy document');
        for(const l of op.lines){await account(l.accountId);const tax=await get('taxRates',l.taxRateId);if(tax.isActive===false||tax.appliesToPurchases===false)throw new Error('Tax rate is not active for purchases');}break;
      }
      case 'create_journal': {
        await get('daybooks',op.daybookId);
        if(op.bankLineId){
          const line=await get('bankLines',op.bankLineId);
          if(line.isReconciled||line.entryDate!==op.entryDate||this.store.bankLineBooked(op.bankLineId))throw new Error('Journal bank line is reconciled, previously booked or dated differently');
          const bankLines=op.lines.filter(l=>l.accountId===line.accountId);
          if(bankLines.length!==1||bankLines[0]!.side!==line.side||cents(bankLines[0]!.amount)!==cents(line.amount))throw new Error('Journal must contain the exact bank line amount, account and direction');
          const existing=await this.client.list('postings',{accountId:line.accountId,minEntryDate:op.entryDate,maxEntryDate:op.entryDate});
          if(existing.some(p=>!p.isVoided&&p.accountId===line.accountId&&p.entryDate===op.entryDate&&p.side===line.side&&cents(p.amount)===cents(line.amount)))throw new Error('Existing bank posting may already book this movement; inspect and reconcile instead');
        }
        if(op.receiptId){
          const r=receipt(op.receiptId),a=await get('attachments',r.attachmentId!);if(a.ownerReference)throw new Error('Receipt already linked');
          if(op.entryDate!==r.metadata.invoiceDate||op.lines[0]!.currencyId!==r.metadata.currencyId||op.lines.filter(l=>l.side==='debit').reduce((n,l)=>n+cents(l.amount),0)!==cents(r.metadata.totalAmount))throw new Error('Journal date, currency or debit total differs from receipt');
        }
        for(const l of op.lines){await account(l.accountId);if(l.taxRateId)throw new Error('Tax-coded journal expansion is not live-verified; use a purchase bill for VAT-coded expenses');}break;
      }
      case 'approve': {
        const record=await get(op.resource,op.id,`${resources[op.resource]}.lines:embed`);
        if(record.state!=='draft')throw new Error('Only drafts can be approved');
        if(!Array.isArray(record.lines)||!record.lines.length)throw new Error('Approval requires embedded draft lines for review');
        if(op.resource==='bills') {
          const attachments=await this.client.list('attachments',{ownerReference:`bill:${op.id}`});
          if(!attachments.length)throw new Error('Bill has no attached supporting document');
          for(const a of attachments)await get('attachments',a.id);
          for(const r of this.store.receipts().filter(r=>attachments.some(a=>a.id===r.attachmentId)))verifyBill(record,r.metadata);
        }break;
      }
      case 'create_payment': {
        const a=await account(op.cashAccountId);if(!a.isPaymentEnabled)throw new Error('Account is not enabled for payments');
        const bankLine=await get('bankLines',op.bankLineId);
        if(bankLine.accountId!==op.cashAccountId||bankLine.side!==op.cashSide||cents(bankLine.amount)!==cents(op.cashAmount)||bankLine.entryDate!==op.entryDate||bankLine.isReconciled)throw new Error('Payment must match an unreconciled bank line account, amount, direction and date');
        if(this.store.bankLineBooked(op.bankLineId))throw new Error('Payment or journal for this bank line was already executed');
        const ref=subject(op.subjectReference), s=await get(ref.resource,ref.id,subjectInclude(ref.resource));
        if(s.state!=='approved'||s.isPaid||!(Number(s.balance)>0))throw new Error('Subject must be approved and have an unpaid balance');
        if((ref.resource==='bills'?'credit':'debit')!==op.cashSide)throw new Error('Payment side does not match bill/invoice');
        const cashCurrency=currencyOf(a),subjectCurrency=currencyOf(s);
        if(!cashCurrency||!subjectCurrency)throw new Error('Payment requires known cash-account and subject currencies');
        const hasFxEvidence=op.subjectAmount!==undefined||op.subjectCurrencyId!==undefined||op.cashExchangeRate!==undefined;
        if(cashCurrency===subjectCurrency){
          if(hasFxEvidence)throw new Error('FX evidence is only valid for a foreign-currency payment');
          if(cents(op.cashAmount)>cents(Number(s.balance)))throw new Error('Payment exceeds outstanding balance');
          break;
        }
        if(ref.resource!=='bills')throw new Error('Foreign-currency payment support is limited to supplier bills');
        if(op.subjectAmount===undefined||op.subjectCurrencyId===undefined||op.cashExchangeRate===undefined)throw new Error('Foreign-currency payment requires subjectAmount, subjectCurrencyId and cashExchangeRate');
        if(op.subjectCurrencyId!==subjectCurrency)throw new Error('FX subjectCurrencyId does not match the approved bill currency');
        if(cents(op.subjectAmount)!==cents(Number(s.balance)))throw new Error('Foreign-currency payment must settle the exact current bill balance');
        const originalRate=numeric(s.exchangeRate);
        if(!Number.isFinite(originalRate)||originalRate<=0)throw new Error('Approved foreign-currency bill has no usable original exchangeRate');
        if(cents(op.subjectAmount*op.cashExchangeRate)!==cents(op.cashAmount))throw new Error('cashExchangeRate does not explain the observed cashAmount for subjectAmount');
        if(!Array.isArray(s.balanceModifiers)||s.balanceModifiers.some((modifier:RecordData)=>!modifier.isVoided))throw new Error('Foreign-currency full settlement requires a bill with no existing payment associations');
        const baseCurrency=typeof organization.baseCurrencyId==='string'?organization.baseCurrencyId:
          (organization.baseCurrency&&typeof organization.baseCurrency.id==='string'?organization.baseCurrency.id:undefined);
        if(!baseCurrency||cashCurrency!==baseCurrency)throw new Error('Foreign-currency payment requires the organization base-currency bank account');
        const roleAccounts=await this.client.list('accounts');
        for(const role of ['accountsPayable','realizedCurrencyDifference']){
          const match=roleAccounts.find(account=>account.systemRole===role&&!account.isArchived);
          if(!match)throw new Error(`Foreign-currency payment requires an active ${role} ledger account`);
          await account(match.id);
        }
        if(!bankLine.matchId)throw new Error('Foreign-currency payment requires an exact bank-line match');
        {
          const match=await get('bankLineMatches',bankLine.matchId,'bankLineMatch.lines:embed,bankLineMatch.subjectAssociations:embed');
          if(match.isApproved||!Array.isArray(match.lines)||!Array.isArray(match.subjectAssociations))throw new Error('Foreign-currency payment requires one inspectable, unapproved bank-line match');
          if(match.lines.length!==1||match.lines[0].id!==bankLine.id)throw new Error('Grouped bank matches require separate review; this payment handles one line');
          if(match.subjectAssociations.length)throw new Error('Bank-line match already has subject associations; inspect in Billy before changing it');
        }
        break;
      }
      case 'reconcile': {
        if(!this.config.bankMatching)throw new Error('Bank matching write contract is not live-verified. Enable only after the documented acceptance test.');
        const line=await get('bankLines',op.bankLineId);
        if(line.isReconciled||!line.matchId)throw new Error('Bank line is already reconciled or has no matchId');
        const match=await get('bankLineMatches',line.matchId,'bankLineMatch.lines:embed,bankLineMatch.subjectAssociations:embed');
        if(match.isApproved)throw new Error('Bank match is already approved');
        if(!Array.isArray(match.lines)||!Array.isArray(match.subjectAssociations))throw new Error('Match relationships were not embedded; verify the live API contract before proceeding');
        if(match.lines.length!==1||match.lines[0].id!==line.id)throw new Error('Grouped bank matches require separate review; this tool handles one line');
        if(match.subjectAssociations.length)throw new Error('Match already has subjects; inspect in Billy before changing it');
        const ref=subject(op.subjectReference);
        if(ref.resource!=='postings')throw new Error('v0.1 reconciles existing bank-account postings only. Create/verify payment before matching a bill or invoice.');
        const posting=await get('postings',ref.id);
        if(posting.isVoided||posting.isBankMatched)throw new Error('Posting is voided or already bank matched');
        if(posting.accountId!==line.accountId||posting.side!==line.side||cents(posting.amount)!==cents(line.amount))throw new Error('Posting does not match bank account, amount and direction');
        break;
      }
    }
    return snapshots;
  }
  async prepare(input:unknown,reason:string) {const op=operation.parse(input);const snapshots=await this.inspect(op);return this.store.prepare(op,snapshots,reason);}
  async refresh(planId:string) {const plan=this.store.plan(planId);return this.store.refresh(planId,await this.inspect(operation.parse(plan.operation)));}
  private async readPaymentLedger(paymentId:string,entryDate:string,response:RecordData) {
    const expectedOriginator=`bankPayment:${paymentId}`;
    const changedTransactions=Array.isArray(response.transactions)?response.transactions:[];
    let transaction=changedTransactions.find((candidate:RecordData)=>candidate.id&&originatorOf(candidate)===expectedOriginator&&candidate.entryDate===entryDate&&!candidate.isVoided&&!candidate.isVoid);
    if(!transaction){
      const listed=await this.client.list('transactions',{entryDate});
      transaction=listed.find(candidate=>candidate.id&&originatorOf(candidate)===expectedOriginator&&candidate.entryDate===entryDate&&!candidate.isVoided&&!candidate.isVoid);
    }
    if(!transaction?.id)throw new Error('Payment ledger transaction with the bank-payment originator was not found');
    const readBack=await this.client.get('transactions',transaction.id,'transaction.postings:embed');
    if(originatorOf(readBack)!==expectedOriginator||readBack.entryDate!==entryDate||readBack.isVoided||readBack.isVoid)throw new Error('Payment ledger transaction originator or date does not match the created bank payment');
    let postings=Array.isArray(readBack.postings)?readBack.postings:[];
    if(!postings.length||postings.some((posting:unknown)=>!posting||typeof posting!=='object'||!accountReference(posting as RecordData)))postings=await this.client.list('postings',{transactionId:transaction.id});
    if(!postings.length)throw new Error('Payment ledger transaction has no postings');
    return {transaction:readBack,postings};
  }
  async execute(planId:string,hash:string) {
    if(!this.config.writes)throw new Error('Writes disabled. Enable BILLY_ALLOW_WRITES locally after reviewing a concrete batch.');
    const existing=this.store.plan(planId);
    if(existing.hash!==hash)throw new Error('Plan hash mismatch');
    if(existing.status==='completed')return existing; // Retries return stored evidence, never repeat HTTP writes.
    const plan=this.store.claim(planId,hash);
    let sent=false,successfulWrites=0;
    try {
      const op=operation.parse(plan.operation), snapshots=await this.inspect(op);
      if(digest(snapshots)!==digest(plan.snapshots))throw new Error('Billy data changed since preview. Refresh and review the plan again.');
      const write=async(resource:Resource,payload:RecordData,id?:string)=>{sent=true;const response=await this.client.write(resource,payload,id);successfulWrites++;return response;};
      const verify=async(resource:Resource,response:RecordData,expected:RecordData)=>{
        const record=response[resource]?.[0];
        if(!record?.id)throw new Error('Write response lacks created/updated record ID');
        const actual=await this.client.get(resource,record.id,resource==='daybookTransactions'?'daybookTransaction.lines:embed':undefined);
        for(const [key,value] of Object.entries(expected)){if(typeof value==='number'){assertMoney(actual[key],value,key);}else if(actual[key]!==value)throw new Error(`Read-back verification failed for ${key}`);}
        return actual;
      };
      let result:any;
      switch(op.kind){
        case 'upload_receipt': {
          const {receipt,bytes}=this.store.receiptBytes(op.receiptId);sent=true;
          const response=await this.client.upload(bytes,receipt.name,receipt.mime);
          successfulWrites++;
          const attachment=response.attachments?.[0];
          if(!attachment?.id||!attachment.fileId)throw new Error('Upload did not return a usable attachment');
          const readBack=await this.client.get('attachments',attachment.id);
          if(readBack.fileId!==attachment.fileId)throw new Error('Upload read-back mismatch');
          receipt.attachmentId=attachment.id;this.store.saveReceipt(receipt);result={receiptId:receipt.id,attachment:readBack};break;
        }
        case 'create_contact': {
          const {kind,...payload}=op;result=await verify('contacts',await write('contacts',payload),{name:op.name,countryId:op.countryId});break;
        }
        case 'create_bill': {
          const {kind,receiptId,...payload}=op,r=this.store.receipt(receiptId);
          const response=await write('bills',{...payload,state:'draft',attachmentIds:[{id:r.attachmentId}]});
          result=await verify('bills',response,{state:'draft',contactId:op.contactId,suppliersInvoiceNo:op.suppliersInvoiceNo,currencyId:op.currencyId});
          verifyBill(result,r.metadata);
          const attachments=await this.client.list('attachments',{ownerReference:`bill:${result.id}`});
          if(!attachments.some(a=>a.id===r.attachmentId))throw new Error('Receipt was not attached to bill');
          break;
        }
        case 'create_journal': {
          const {kind,receiptId,noReceiptReason,bankLineId,...payload}=op;
          result=await verify('daybookTransactions',await write('daybookTransactions',{...payload,state:'draft',...(receiptId?{attachmentIds:[{id:this.store.receipt(receiptId).attachmentId}]}:{})}),{state:'draft',entryDate:op.entryDate});
          verifyLines(result,op.lines);
          if(receiptId){const attachments=await this.client.list('attachments',{ownerReference:`daybookTransaction:${result.id}`});if(!attachments.some(a=>a.id===this.store.receipt(receiptId).attachmentId))throw new Error('Journal receipt link not confirmed');}
          break;
        }
        case 'approve': result=await verify(op.resource,await write(op.resource,{state:'approved'},op.id),{state:'approved'});break;
        case 'create_payment': {
          const {kind,subjectReference,bankLineId,subjectAmount,subjectCurrencyId,...payload}=op;
          const ref=subject(subjectReference),before=await this.client.get(ref.resource,ref.id,subjectInclude(ref.resource));
          const response=await write('bankPayments',{...payload,associations:[{subjectReference}]});
          const payment=await verify('bankPayments',response,{cashAmount:op.cashAmount,cashSide:op.cashSide,cashAccountId:op.cashAccountId});
          const paymentRead=await this.client.get('bankPayments',payment.id,'bankPayment.associations:embed');
          const paymentSubjectCurrency=typeof paymentRead.subjectCurrencyId==='string'?paymentRead.subjectCurrencyId:
            (paymentRead.subjectCurrency&&typeof paymentRead.subjectCurrency.id==='string'?paymentRead.subjectCurrency.id:undefined);
          const paymentCashAccount=typeof paymentRead.cashAccountId==='string'?paymentRead.cashAccountId:
            (paymentRead.cashAccount&&typeof paymentRead.cashAccount.id==='string'?paymentRead.cashAccount.id:undefined);
          if(paymentCashAccount&&paymentCashAccount!==op.cashAccountId)throw new Error('Payment read-back cash account differs from the exact bank account');
          if(paymentRead.entryDate!==op.entryDate||paymentRead.isVoided===true)throw new Error('Payment read-back date or void state differs from the reviewed bank line');
          if(cents(paymentRead.cashAmount)!==cents(op.cashAmount)||paymentRead.cashSide!==op.cashSide)throw new Error('Payment read-back cash amount or direction differs from the exact bank line');
          if(!Array.isArray(paymentRead.associations)||paymentRead.associations.length!==1)throw new Error('Payment read-back must contain exactly one subject association');
          const association=paymentRead.associations[0];
          if(associationSubject(association)!==subjectReference||association.isVoided)throw new Error('Payment read-back subject association differs from the reviewed bill');
          const foreign=subjectAmount!==undefined;
          if(foreign){
            if(paymentSubjectCurrency!==subjectCurrencyId)throw new Error('Payment read-back subject currency differs from the reviewed bill');
            if(!close(paymentRead.cashExchangeRate,op.cashExchangeRate!))throw new Error('Payment read-back exchange rate differs from the reviewed bank payment');
            if(cents(association.amount)!==-cents(subjectAmount!))throw new Error('Payment association amount does not settle the reviewed subject amount');
            const originalRate=numeric(before.exchangeRate);
            if(!Number.isFinite(originalRate)||originalRate<=0)throw new Error('Payment read-back cannot verify the original bill exchange rate');
            const modifier=associationModifier(association);
            if(modifier&&modifier!==`bankPayment:${payment.id}`)throw new Error('Payment association modifier does not reference the created bank payment');
          }
          const after=await this.client.get(ref.resource,ref.id,subjectInclude(ref.resource));
          const expectedSubjectDelta=foreign?subjectAmount!:op.cashAmount;
          if(cents(before.balance)-cents(after.balance)!==cents(expectedSubjectDelta))throw new Error('Payment balance change does not match the reviewed subject amount');
          let ledger:any;
          if(foreign){
            if(currencyOf(after)!==subjectCurrencyId||cents(after.balance)!==0||after.isPaid!==true)throw new Error('Foreign-currency bill was not read back as fully paid in its subject currency');
            if(!Array.isArray(after.balanceModifiers))throw new Error('Bill read-back did not include payment associations');
            const matching=after.balanceModifiers.filter((modifier:RecordData)=>!modifier.isVoided&&associationSubject(modifier)===subjectReference);
            if(matching.length!==1)throw new Error('Bill read-back does not contain exactly one non-voided payment association');
            const roles=ledgerAccounts(snapshots);
            if(!roles.payable||!roles.fx)throw new Error('Payment ledger account snapshots are incomplete');
            const cashAccount=snapshots.find(snapshot=>snapshot.resource==='accounts'&&snapshot.id===op.cashAccountId)?.record;
            const cashCurrency=cashAccount&&currencyOf(cashAccount);
            if(!cashCurrency)throw new Error('Payment ledger cash currency is unavailable');
            ledger=await this.readPaymentLedger(payment.id,op.entryDate,response);
            const activePostings=ledger.postings.filter((posting:RecordData)=>!posting.isVoided);
            const liabilityCents=cents(subjectAmount!*numeric(before.exchangeRate));
            const differenceCents=cents(op.cashAmount)-liabilityCents;
            const postingMatches=(posting:RecordData,accountId:string,side:string,amount:number,currencyId:string)=>accountReference(posting)===accountId&&posting.side===side&&cents(posting.amount)===amount&&currencyOf(posting)===currencyId;
            if(activePostings.filter((posting:RecordData)=>postingMatches(posting,op.cashAccountId,op.cashSide,cents(op.cashAmount),cashCurrency)).length!==1)throw new Error('Payment ledger lacks the exact cash-account posting');
            if(activePostings.filter((posting:RecordData)=>postingMatches(posting,roles.payable!.id,'debit',liabilityCents,cashCurrency)).length!==1)throw new Error('Payment ledger lacks the original supplier-liability posting');
            const expectedPostingCount=differenceCents===0?2:3;
            if(activePostings.length!==expectedPostingCount)throw new Error('Payment ledger contains an unexpected fee or extra posting');
            if(differenceCents!==0){
              const differenceSide=differenceCents>0?'debit':'credit';
              if(activePostings.filter((posting:RecordData)=>postingMatches(posting,roles.fx!.id,differenceSide,Math.abs(differenceCents),cashCurrency)).length!==1)throw new Error('Payment ledger lacks the exact realized currency-difference posting');
            }
            if(activePostings.reduce((sum:number,posting:RecordData)=>sum+(posting.side==='debit'?1:-1)*cents(posting.amount),0)!==0)throw new Error('Payment ledger postings do not balance');
          }
          result={payment:paymentRead,subject:after,...(ledger?{ledger}: {})};break;
        }
        case 'reconcile': {
          const line=await this.client.get('bankLines',op.bankLineId);
          await write('bankLineSubjectAssociations',{matchId:line.matchId,subjectReference:op.subjectReference});
          await write('bankLineMatches',{isApproved:true},line.matchId);
          const match=await this.client.get('bankLineMatches',line.matchId),posting=await this.client.get('postings',subject(op.subjectReference).id);
          if(!match.isApproved||!posting.isBankMatched)throw new Error('Reconciliation read-back not confirmed');
          result={match,posting};break;
        }
      }
      return this.store.finish(plan.id,'completed',result);
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      const definitiveRejection=successfulWrites===0&&error instanceof BillyError&&[400,401,403,404,409,422,429].includes(error.status??0);
      this.store.finish(plan.id,sent&&!definitiveRejection?'unknown':'rejected',{error:message});throw error;
    }
  }
  async overview(start:string,end:string) {
    if(start>end)throw new Error('Start must precede end');await this.client.verifyOrganization();
    const accounts=await this.client.list('accounts',{isBankAccount:true});
    const lines:RecordData[]=[];
    for(const a of accounts.filter(a=>a.isBankAccount&&!a.isArchived))lines.push(...await this.client.list('bankLines',{accountId:a.id,minEntryDate:start,maxEntryDate:end,isReconciled:false}));
    const postings=await this.client.list('postings',{minEntryDate:start,maxEntryDate:end,isBankMatched:false});
    const bills=await this.client.list('bills',{minEntryDate:start,maxEntryDate:end});
    return {period:{start,end},unreconciledBankLines:lines.filter(l=>!l.isReconciled&&l.entryDate>=start&&l.entryDate<=end).map(line=>({...line,candidatePostings:postings.filter(p=>!p.isVoided&&!p.isBankMatched&&p.accountId===line.accountId&&p.side===line.side&&cents(p.amount)===cents(line.amount)).map(p=>({id:p.id,text:p.text,entryDate:p.entryDate})),
      note:'Candidates are amount/account/direction matches, not confirmed links. Check invoice reference and date; postings outside this period are not included.'})),
      bills:bills.filter(b=>b.entryDate>=start&&b.entryDate<=end), receipts:this.store.receipts().map(({path,...r})=>r),vendors:this.store.vendors(),
      completion:'Inventory only. Missing documents, portal access and ambiguous accounting must be resolved before reporting the period complete.'};
  }
}
