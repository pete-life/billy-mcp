import {BillyClient, BillyError, type Resource, type RecordData, resources} from './client.js';
import {Store, digest, type Plan} from './store.js';
import {operation, type Operation} from './schemas.js';
import type {Config} from './config.js';
type BatchLease={batchId:string;nonce:string};

const cents=(v:number)=>Math.round(v*100);
const exactCent=(v:number)=>Number.isFinite(v)&&Math.abs(v*100-Math.round(v*100))<0.000001;
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
  return {payable:accounts.find(account=>account.systemRole==='accountsPayable'),receivable:accounts.find(account=>account.systemRole==='accountsReceivable'),fx:accounts.find(account=>account.systemRole==='realizedCurrencyDifference')};
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
function verifyInvoice(actual:RecordData,op:{expectedNetAmount:number;expectedTaxAmount:number;expectedTotalAmount:number;lines?:RecordData[]}) {
  assertMoney(actual.amount,op.expectedNetAmount,'invoice net amount');
  assertMoney(actual.tax,op.expectedTaxAmount,'invoice VAT');
  assertMoney(Number(actual.amount)+Number(actual.tax),op.expectedTotalAmount,'invoice gross total');
  if(op.lines){
    if(!Array.isArray(actual.lines)||actual.lines.length!==op.lines.length)throw new Error('Invoice read-back lines are missing or changed');
    for(let i=0;i<op.lines.length;i++){
      const wanted=op.lines[i]!,line=actual.lines[i]!;
      if(line.productId!==wanted.productId||line.taxRateId!==wanted.expectedTaxRateId||!close(line.quantity,wanted.quantity)||cents(line.unitPrice)!==cents(wanted.unitPrice)||
        (wanted.description!==undefined&&line.description!==wanted.description))throw new Error('Invoice read-back product, quantity, unit price or sales tax differs');
    }
  }
}
function verifyLines(actual:RecordData, expected:RecordData[]) {
  if(!Array.isArray(actual.lines)||actual.lines.length!==expected.length)throw new Error('Read-back lines are missing or changed');
  const remaining=[...actual.lines];
  for(const line of expected){
    const index=remaining.findIndex(candidate=>Object.entries(line).every(([key,value])=>key==='amount'?Number.isFinite(Number(candidate[key]))&&cents(Number(candidate[key]))===cents(value):candidate[key]===value));
    if(index<0)throw new Error('Read-back line account, amount, direction, tax or text differs');remaining.splice(index,1);
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
        if(r.metadata.documentType==='creditNote')throw new Error('Supplier credit document requires a linked supplier credit note, not an ordinary bill');
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
      case 'create_sales_invoice': {
        const contact=await get('contacts',op.contactId);
        if(!contact.isCustomer||contact.isArchived)throw new Error('Invoice contact must be an active customer');
        for(const line of op.lines){
          const product=await get('products',line.productId);
          if(product.isArchived||!product.accountId||product.salesTaxRulesetId!==line.salesTaxRulesetId)throw new Error('Product is archived or its sales account/tax ruleset differs');
          await account(product.accountId);
          await get('salesTaxRulesets',line.salesTaxRulesetId);
          const tax=await get('taxRates',line.expectedTaxRateId);
          if(tax.isActive===false||tax.appliesToSales===false)throw new Error('Expected sales tax is inactive or not for sales');
        }
        break;
      }
      case 'update_draft_invoice': {
        const invoice=await get('invoices',op.id,'invoice.lines:embed');
        if(invoice.state!=='draft'||invoice.type!=='invoice'||!Array.isArray(invoice.lines)||!invoice.lines.length)throw new Error('Only an ordinary draft invoice with embedded lines can be edited');
        break;
      }
      case 'send_invoice': {
        const invoice=await get('invoices',op.id,'invoice.lines:embed');
        if(invoice.state!=='approved'||invoice.type!=='invoice'||invoice.sentState!=='unsent')throw new Error('Only an approved, unsent ordinary invoice can be emailed');
        if(!Array.isArray(invoice.lines)||!invoice.lines.length)throw new Error('Invoice lines must be inspectable before sending');
        const person=await get('contactPersons',op.contactPersonId);
        if(person.contactId!==invoice.contactId||normalize(person.email)!==normalize(op.recipientEmail))throw new Error('Recipient email or contact does not match invoice customer');
        break;
      }
      case 'create_customer_credit_note': {
        const original=await get('invoices',op.originalInvoiceId,'invoice.lines:embed');
        if(original.state!=='approved'||original.type!=='invoice'||!Array.isArray(original.lines)||!original.lines.length)throw new Error('Credit note requires an approved ordinary original invoice with lines');
        if(!original.contactId||!currencyOf(original)||!['incl','excl'].includes(original.taxMode))throw new Error('Original invoice lacks contact, currency or tax mode');
        if(!Number.isFinite(Number(original.amount))||!Number.isFinite(Number(original.tax)))throw new Error('Original invoice totals are unavailable');
        const credits=(await this.client.list('invoices',{creditedInvoiceId:op.originalInvoiceId})).filter(c=>c.creditedInvoiceId===op.originalInvoiceId&&c.state!=='voided');
        const prior=[] as RecordData[];
        for(const credit of credits)prior.push(await get('invoices',credit.id,'invoice.lines:embed'));
        const seen=new Set<string>();
        for(const line of op.lines){
          const source=original.lines.find((candidate:RecordData)=>candidate.id===line.originalLineId);
          if(!source||source.productId!==line.productId||source.taxRateId!==line.expectedTaxRateId||seen.has(line.originalLineId))throw new Error('Credit line must identify one distinct original product and sales tax line');
          if(!Number.isFinite(Number(source.amount))||!Number.isFinite(Number(source.tax)))throw new Error('Original invoice line amount or tax is unavailable');
          seen.add(line.originalLineId);
          if(original.lines.filter((candidate:RecordData)=>candidate.productId===line.productId).length!==1)throw new Error('Original repeats a product; credit allocation is ambiguous');
          const product=await get('products',line.productId);
          if(product.salesTaxRulesetId!==line.salesTaxRulesetId)throw new Error('Credit product sales tax ruleset differs');
          await get('salesTaxRulesets',line.salesTaxRulesetId);
          const tax=await get('taxRates',line.expectedTaxRateId);
          if(tax.isActive===false||tax.appliesToSales===false)throw new Error('Credit sales tax is inactive or not for sales');
          const previous=prior.flatMap(credit=>Array.isArray(credit.lines)?credit.lines:[]).filter((candidate:RecordData)=>candidate.productId===line.productId);
          if(prior.some(credit=>!Array.isArray(credit.lines)||credit.type!=='creditNote'||credit.contactId!==original.contactId||currencyOf(credit)!==currencyOf(original)||
            !Number.isFinite(Number(credit.amount))||!Number.isFinite(Number(credit.tax))||credit.lines.some((candidate:RecordData)=>!Number.isFinite(Number(candidate.amount))||!Number.isFinite(Number(candidate.tax)))))throw new Error('Existing linked credits are not inspectable or differ from original');
          if(cents(line.quantity*line.unitPrice)+previous.reduce((n:number,candidate:RecordData)=>n+cents(candidate.amount)+(original.taxMode==='incl'?cents(candidate.tax):0),0)>cents(source.amount)+(original.taxMode==='incl'?cents(source.tax):0))throw new Error('Credit exceeds the original invoice line');
          if(previous.some((candidate:RecordData)=>close(candidate.quantity,line.quantity)&&cents(candidate.unitPrice)===cents(line.unitPrice)))throw new Error('Duplicate customer credit line already exists');
        }
        const priorNet=prior.reduce((n,credit)=>n+cents(credit.amount),0),priorTax=prior.reduce((n,credit)=>n+cents(credit.tax),0);
        if(priorNet+cents(op.expectedNetAmount)>cents(original.amount)||priorTax+cents(op.expectedTaxAmount)>cents(original.tax))throw new Error('Credit would exceed original net amount or VAT');
        break;
      }
      case 'create_supplier_credit_note': {
        const r=receipt(op.receiptId),original=await get('bills',op.originalBillId,'bill.lines:embed');
        if(r.metadata.documentType!=='creditNote'||r.metadata.creditedInvoiceNumber!==original.suppliersInvoiceNo)throw new Error('Supplier credit document must identify the original supplier invoice number');
        if(original.state!=='approved'||original.type!=='bill'||!Array.isArray(original.lines)||!original.lines.length)throw new Error('Supplier credit requires an approved ordinary original bill with lines');
        if(!original.contactId||!currencyOf(original)||!['incl','excl'].includes(original.taxMode)||currencyOf(original)!==r.metadata.currencyId)throw new Error('Original bill contact, tax mode or currency differs from credit document');
        const contact=await get('contacts',original.contactId);
        if(!contact.isSupplier||!supplierMatches(contact,r.metadata))throw new Error('Supplier credit document does not match original supplier identity');
        if(op.entryDate!==r.metadata.invoiceDate||cents(op.expectedNetAmount)!==cents(r.metadata.netAmount)||cents(op.expectedTaxAmount)!==cents(r.metadata.vatAmount)||
          cents(op.expectedTotalAmount)!==cents(r.metadata.totalAmount))throw new Error('Supplier credit date, net, VAT or gross differs from uploaded document');
        if(!Number.isFinite(Number(original.amount))||!Number.isFinite(Number(original.tax)))throw new Error('Original bill totals are unavailable');
        const attachment=await get('attachments',r.attachmentId!);
        if(attachment.ownerReference)throw new Error('Supplier credit document already belongs to another Billy record');
        const duplicate=(await this.client.list('bills',{suppliersInvoiceNo:r.metadata.invoiceNumber})).some(b=>b.contactId===original.contactId&&normalize(b.suppliersInvoiceNo)===normalize(r.metadata.invoiceNumber));
        if(duplicate)throw new Error('Supplier credit document number already exists');
        const prior=(await this.client.list('bills',{creditedBillId:op.originalBillId})).filter(b=>b.creditedBillId===op.originalBillId&&b.state!=='voided');
        const priorDetails=[] as RecordData[];
        for(const credit of prior)priorDetails.push(await get('bills',credit.id,'bill.lines:embed'));
        if(priorDetails.some(credit=>credit.type!=='creditNote'||credit.contactId!==original.contactId||currencyOf(credit)!==currencyOf(original)||
          !Array.isArray(credit.lines)||!Number.isFinite(Number(credit.amount))||!Number.isFinite(Number(credit.tax))||
          credit.lines.some((line:RecordData)=>!Number.isFinite(Number(line.amount))||!Number.isFinite(Number(line.tax)))))throw new Error('Existing supplier credits are not inspectable or differ from original');
        const selected=new Set<string>();
        let entered=0;
        for(const line of op.lines){
          const source=original.lines.find((candidate:RecordData)=>candidate.id===line.originalLineId);
          if(!source||source.accountId!==line.accountId||source.taxRateId!==line.taxRateId||selected.has(line.originalLineId))throw new Error('Supplier credit line must identify one distinct original account and tax line');
          if(original.lines.filter((candidate:RecordData)=>candidate.accountId===line.accountId&&candidate.taxRateId===line.taxRateId).length!==1)throw new Error('Original repeats an account and tax pair; credit allocation is ambiguous');
          if(!Number.isFinite(Number(source.amount))||!Number.isFinite(Number(source.tax)))throw new Error('Original bill line amount or VAT is unavailable');
          selected.add(line.originalLineId);entered+=cents(line.amount);
          await account(line.accountId);
          const tax=await get('taxRates',line.taxRateId);
          if(tax.isActive===false||tax.appliesToPurchases===false)throw new Error('Supplier credit tax rate is inactive or not for purchases');
          const previous=priorDetails.flatMap(credit=>credit.lines).filter((candidate:RecordData)=>candidate.accountId===line.accountId&&candidate.taxRateId===line.taxRateId);
          if(cents(line.amount)+previous.reduce((n:number,candidate:RecordData)=>n+cents(candidate.amount),0)>cents(source.amount))throw new Error('Supplier credit exceeds original bill line');
          if(previous.some((candidate:RecordData)=>cents(candidate.amount)===cents(line.amount)&&normalize(candidate.description)===normalize(line.description)))throw new Error('Duplicate supplier credit line already exists');
        }
        if(entered!==cents(original.taxMode==='incl'?op.expectedTotalAmount:op.expectedNetAmount))throw new Error('Supplier credit lines do not match uploaded document totals');
        if(priorDetails.reduce((n,credit)=>n+cents(credit.amount),0)+cents(op.expectedNetAmount)>cents(original.amount)||
          priorDetails.reduce((n,credit)=>n+cents(credit.tax),0)+cents(op.expectedTaxAmount)>cents(original.tax))throw new Error('Supplier credit would exceed original net amount or VAT');
        break;
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
        if(op.feeAmount!==undefined){
          if(!organization.defaultBankFeeAccountId||organization.defaultBankFeeAccountId!==op.feeAccountId)throw new Error('Fee account must match the organization configured bank-fee expense account');
          if(op.feeAccountId===op.cashAccountId)throw new Error('Fee expense account cannot be the cash account');
          await account(op.feeAccountId!);
        }
        const bankLine=await get('bankLines',op.bankLineId);
        if(bankLine.accountId!==op.cashAccountId||bankLine.side!==op.cashSide||cents(bankLine.amount)!==cents(op.cashAmount)||bankLine.entryDate!==op.entryDate||bankLine.isReconciled)throw new Error('Payment must match an unreconciled bank line account, amount, direction and date');
        if(this.store.bankLineBooked(op.bankLineId))throw new Error('Payment or journal for this bank line was already executed');
        if(!bankLine.matchId)throw new Error('Payment requires an exact bank-line match');
        {
          const match=await get('bankLineMatches',bankLine.matchId,'bankLineMatch.lines:embed,bankLineMatch.subjectAssociations:embed');
          if(match.isApproved!==false||!Array.isArray(match.lines)||!Array.isArray(match.subjectAssociations))throw new Error('Payment requires one inspectable, unapproved bank-line match');
          if(match.lines.length!==1||match.lines[0].id!==bankLine.id)throw new Error('Grouped bank matches require separate review; this payment handles one line');
          if(match.subjectAssociations.length)throw new Error('Bank-line match already has subject associations; inspect in Billy before changing it');
        }
        const ref=subject(op.subjectReference), s=await get(ref.resource,ref.id,subjectInclude(ref.resource));
        if(s.state!=='approved'||s.isPaid||!(Number(s.balance)>0))throw new Error('Subject must be approved and have an unpaid balance');
        if((ref.resource==='bills'?'credit':'debit')!==op.cashSide)throw new Error('Payment side does not match bill/invoice');
        const cashCurrency=currencyOf(a),subjectCurrency=currencyOf(s);
        if(!cashCurrency||!subjectCurrency)throw new Error('Payment requires known cash-account and subject currencies');
        const fee=op.feeAmount??0;
        const appliedCash=op.cashAmount+(op.cashSide==='debit'?fee:-fee);
        if(cents(appliedCash)<=0)throw new Error('Payment fee consumes the entire bank movement');
        const reviewedSubject=op.subjectAmount??appliedCash;
        if(cents(reviewedSubject)>cents(Number(s.balance)))throw new Error('Payment exceeds outstanding balance');
        if(cashCurrency===subjectCurrency){
          if(op.subjectCurrencyId!==undefined||op.cashExchangeRate!==undefined)throw new Error('FX evidence is only valid for a foreign-currency payment');
          if(cents(reviewedSubject)!==cents(appliedCash))throw new Error('Subject amount does not match bank cash plus or minus explicit fee');
        }else{
          if(ref.resource!=='bills')throw new Error('Foreign-currency payment support is limited to supplier bills');
          if(op.subjectAmount===undefined||op.subjectCurrencyId===undefined||op.cashExchangeRate===undefined)throw new Error('Foreign-currency payment requires subjectAmount, subjectCurrencyId and cashExchangeRate');
          if(op.subjectCurrencyId!==subjectCurrency)throw new Error('FX subjectCurrencyId does not match the approved bill currency');
          const originalRate=numeric(s.exchangeRate);
          if(!Number.isFinite(originalRate)||originalRate<=0)throw new Error('Approved foreign-currency bill has no usable original exchangeRate');
          if(!Array.isArray(s.balanceModifiers))throw new Error('Foreign-currency payment requires inspectable existing payment associations');
          if(!exactCent(op.subjectAmount*originalRate)||s.balanceModifiers.some((modifier:RecordData)=>!modifier.isVoided&&(!Number.isFinite(Number(modifier.amount))||!exactCent(Math.abs(Number(modifier.amount))*originalRate))))
            throw new Error('Foreign-currency partial payment has ambiguous original-liability cent rounding; review in Billy');
          if(cents(op.subjectAmount*op.cashExchangeRate)!==cents(appliedCash))throw new Error('cashExchangeRate does not explain bank cash and fee for subjectAmount');
          const baseCurrency=typeof organization.baseCurrencyId==='string'?organization.baseCurrencyId:
            (organization.baseCurrency&&typeof organization.baseCurrency.id==='string'?organization.baseCurrency.id:undefined);
          if(!baseCurrency||cashCurrency!==baseCurrency)throw new Error('Foreign-currency payment requires the organization base-currency bank account');
        }
        if(fee){
          const baseCurrency=typeof organization.baseCurrencyId==='string'?organization.baseCurrencyId:
            (organization.baseCurrency&&typeof organization.baseCurrency.id==='string'?organization.baseCurrency.id:undefined);
          if(!baseCurrency||cashCurrency!==baseCurrency)throw new Error('Fee-bearing payment requires the organization base-currency bank account for ledger verification');
        }
        if(cashCurrency!==subjectCurrency||fee){
          const roleAccounts=await this.client.list('accounts');
          for(const role of [ref.resource==='bills'?'accountsPayable':'accountsReceivable',...(cashCurrency!==subjectCurrency?['realizedCurrencyDifference']:[])]){
            const match=roleAccounts.find(candidate=>candidate.systemRole===role&&!candidate.isArchived);
            if(!match)throw new Error(`Payment requires an active ${role} ledger account`);
            await account(match.id);
          }
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
  async resolvePaymentCashPosting(paymentPlanId:string):Promise<{postingId:string;paymentId:string;bankLineId:string}> {
    await this.client.verifyOrganization();
    const plan=this.store.plan(paymentPlanId),op=operation.parse(plan.operation);
    if(plan.status!=='completed'||op.kind!=='create_payment'||!plan.result?.payment?.id)throw new Error('A completed reviewed payment is required to resolve its bank posting');
    const paymentId=plan.result.payment.id;
    const payment=await this.client.get('bankPayments',paymentId,'bankPayment.associations:embed');
    if(payment.entryDate!==op.entryDate||payment.cashAccountId!==op.cashAccountId||payment.cashSide!==op.cashSide||cents(payment.cashAmount)!==cents(op.cashAmount)||payment.isVoided)throw new Error('Payment no longer matches the completed bank line booking');
    const ledger=await this.readPaymentLedger(paymentId,op.entryDate,{});
    const account=await this.client.get('accounts',op.cashAccountId),currency=currencyOf(account);
    if(!currency)throw new Error('Cash account currency is unavailable');
    const matches=ledger.postings.filter((posting:RecordData)=>!posting.isVoided&&accountReference(posting)===op.cashAccountId&&posting.side===op.cashSide&&cents(posting.amount)===cents(op.cashAmount)&&currencyOf(posting)===currency);
    if(matches.length!==1||!matches[0].id)throw new Error('Payment does not have one exact cash posting for reconciliation');
    return {postingId:matches[0].id,paymentId,bankLineId:op.bankLineId};
  }
  async execute(planId:string,hash:string,batchLease?:BatchLease) {
    if(!this.config.writes)throw new Error('Writes disabled. Enable BILLY_ALLOW_WRITES locally after reviewing a concrete batch.');
    const existing=this.store.plan(planId);
    if(existing.hash!==hash)throw new Error('Plan hash mismatch');
    if(existing.status==='completed')return existing; // Retries return stored evidence, never repeat HTTP writes.
    const plan=(this.store.claim as (id:string,hash:string,lease?:BatchLease)=>Plan)(planId,hash,batchLease);
    let sent=false,successfulWrites=0;
    try {
      const op=operation.parse(plan.operation), snapshots=await this.inspect(op);
      if(digest(snapshots)!==digest(plan.snapshots))throw new Error('Billy data changed since preview. Refresh and review the plan again.');
      const write=async(resource:Resource,payload:RecordData,id?:string)=>{sent=true;const response=await this.client.write(resource,payload,id);successfulWrites++;return response;};
      const verify=async(resource:Resource,response:RecordData,expected:RecordData)=>{
        const record=response[resource]?.[0];
        if(!record?.id)throw new Error('Write response lacks created/updated record ID');
        const actual=await this.client.get(resource,record.id,resource==='daybookTransactions'?'daybookTransaction.lines:embed':resource==='invoices'?'invoice.lines:embed':resource==='bills'?'bill.lines:embed':undefined);
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
        case 'create_sales_invoice': {
          const lines=op.lines.map(({salesTaxRulesetId,expectedTaxRateId,...line})=>line);
          const response=await write('invoices',{contactId:op.contactId,entryDate:op.entryDate,currencyId:op.currencyId,taxMode:op.taxMode,
            contactMessage:op.contactMessage,lines,state:'draft'});
          const invoice=await verify('invoices',response,{state:'draft',contactId:op.contactId,entryDate:op.entryDate,currencyId:op.currencyId,taxMode:op.taxMode});
          if(invoice.type!=='invoice')throw new Error('Created sales invoice has an unexpected type');
          verifyInvoice(invoice,op);result=invoice;break;
        }
        case 'update_draft_invoice': {
          const {kind,id,expectedNetAmount,expectedTaxAmount,expectedTotalAmount,...patch}=op;
          const invoice=await verify('invoices',await write('invoices',patch,id),{state:'draft',...patch});
          if(invoice.type!=='invoice')throw new Error('Updated record has an unexpected invoice type');
          verifyInvoice(invoice,op);result=invoice;break;
        }
        case 'send_invoice': {
          sent=true;
          const response=await this.client.sendInvoiceEmail(op.id,op.contactPersonId,op.emailSubject,op.emailBody);
          successfulWrites++;
          const invoice=await this.client.get('invoices',op.id);
          if(invoice.state!=='approved'||!['sent','opened','viewed'].includes(invoice.sentState))throw new Error('Invoice email write was not confirmed by invoice sent state');
          result={invoiceId:op.id,contactPersonId:op.contactPersonId,recipientEmail:op.recipientEmail,emailSubject:op.emailSubject,
            sentState:invoice.sentState,response};break;
        }
        case 'create_customer_credit_note': {
          const original=snapshots.find(s=>s.resource==='invoices'&&s.id===op.originalInvoiceId)?.record;
          if(!original)throw new Error('Original invoice snapshot is missing');
          const lines=op.lines.map(({originalLineId,salesTaxRulesetId,expectedTaxRateId,...line})=>line);
          const response=await write('invoices',{type:'creditNote',creditedInvoiceId:op.originalInvoiceId,contactId:original.contactId,
            entryDate:op.entryDate,currencyId:currencyOf(original),taxMode:original.taxMode,lines,state:'draft'});
          const credit=await verify('invoices',response,{type:'creditNote',creditedInvoiceId:op.originalInvoiceId,contactId:original.contactId,
            entryDate:op.entryDate,currencyId:currencyOf(original),taxMode:original.taxMode,state:'draft'});
          verifyInvoice(credit,op);result=credit;break;
        }
        case 'create_supplier_credit_note': {
          const original=snapshots.find(s=>s.resource==='bills'&&s.id===op.originalBillId)?.record;
          if(!original)throw new Error('Original bill snapshot is missing');
          const receipt=this.store.receipt(op.receiptId);
          const lines=op.lines.map(({originalLineId,...line})=>line);
          const response=await write('bills',{type:'creditNote',creditedBillId:op.originalBillId,contactId:original.contactId,
            entryDate:op.entryDate,suppliersInvoiceNo:receipt.metadata.invoiceNumber,currencyId:currencyOf(original),taxMode:original.taxMode,
            lines,state:'draft',attachmentIds:[{id:receipt.attachmentId}]});
          const credit=await verify('bills',response,{type:'creditNote',creditedBillId:op.originalBillId,contactId:original.contactId,
            entryDate:op.entryDate,suppliersInvoiceNo:receipt.metadata.invoiceNumber,currencyId:currencyOf(original),taxMode:original.taxMode,state:'draft'});
          verifyBill(credit,receipt.metadata);
          verifyLines(credit,lines);
          const attachments=await this.client.list('attachments',{ownerReference:`bill:${credit.id}`});
          if(!attachments.some(a=>a.id===receipt.attachmentId))throw new Error('Supplier credit document attachment was not confirmed');
          result=credit;break;
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
          if(paymentCashAccount!==op.cashAccountId)throw new Error('Payment read-back cash account differs from the exact bank account');
          if(paymentRead.entryDate!==op.entryDate||paymentRead.isVoided===true)throw new Error('Payment read-back date or void state differs from the reviewed bank line');
          if(cents(paymentRead.cashAmount)!==cents(op.cashAmount)||paymentRead.cashSide!==op.cashSide)throw new Error('Payment read-back cash amount or direction differs from the exact bank line');
          if(!Array.isArray(paymentRead.associations)||paymentRead.associations.length!==1)throw new Error('Payment read-back must contain exactly one subject association');
          const association=paymentRead.associations[0];
          if(associationSubject(association)!==subjectReference||association.isVoided)throw new Error('Payment read-back subject association differs from the reviewed bill');
          const cashAccount=snapshots.find(snapshot=>snapshot.resource==='accounts'&&snapshot.id===op.cashAccountId)?.record;
          const cashCurrency=cashAccount&&currencyOf(cashAccount),subjectCurrency=currencyOf(before);
          if(!cashCurrency||!subjectCurrency)throw new Error('Payment snapshot currencies are unavailable');
          const foreign=cashCurrency!==subjectCurrency,fee=op.feeAmount??0;
          const appliedCash=op.cashAmount+(op.cashSide==='debit'?fee:-fee);
          const expectedSubjectDelta=subjectAmount??appliedCash;
          if(paymentSubjectCurrency!==subjectCurrency)throw new Error('Payment read-back subject currency differs from the reviewed subject');
          if(foreign){
            if(paymentSubjectCurrency!==subjectCurrencyId)throw new Error('Payment read-back subject currency differs from the reviewed bill');
            if(!close(paymentRead.cashExchangeRate,op.cashExchangeRate!))throw new Error('Payment read-back exchange rate differs from the reviewed bank payment');
          }
          if(!Number.isFinite(Number(paymentRead.feeAmount??0))||cents(Number(paymentRead.feeAmount??0))!==cents(fee)||
            (fee&&paymentRead.feeAccountId!==op.feeAccountId))throw new Error('Payment read-back fee amount or expense account differs');
          if(cents(association.amount)!==-cents(expectedSubjectDelta))throw new Error('Payment association amount does not match the reviewed subject amount');
          const modifier=associationModifier(association);
          if(modifier&&modifier!==`bankPayment:${payment.id}`)throw new Error('Payment association modifier does not reference the created bank payment');
          const after=await this.client.get(ref.resource,ref.id,subjectInclude(ref.resource));
          if(cents(before.balance)-cents(after.balance)!==cents(expectedSubjectDelta))throw new Error('Payment balance change does not match the reviewed subject amount');
          if(currencyOf(after)!==subjectCurrency||after.isPaid!==(cents(after.balance)===0))throw new Error('Subject currency or paid status does not match the new balance');
          if(!Array.isArray(after.balanceModifiers)||!after.balanceModifiers.some((item:RecordData)=>!item.isVoided&&associationModifier(item)===`bankPayment:${payment.id}`))throw new Error('Subject read-back lacks the new payment association');
          let ledger:any;
          if(foreign||fee){
            const roles=ledgerAccounts(snapshots);
            const liability=ref.resource==='bills'?roles.payable:roles.receivable;
            if(!liability||(foreign&&!roles.fx))throw new Error('Payment ledger role account snapshots are incomplete');
            ledger=await this.readPaymentLedger(payment.id,op.entryDate,response);
            const activePostings=ledger.postings.filter((posting:RecordData)=>!posting.isVoided);
            const originalRate=foreign?numeric(before.exchangeRate):1;
            if(!Number.isFinite(originalRate)||originalRate<=0)throw new Error('Payment ledger cannot verify original exchange rate');
            const liabilityCents=cents(expectedSubjectDelta*originalRate);
            const differenceCents=cents(appliedCash)-liabilityCents;
            const postingMatches=(posting:RecordData,accountId:string,side:string,amount:number,currencyId:string)=>accountReference(posting)===accountId&&posting.side===side&&cents(posting.amount)===amount&&currencyOf(posting)===currencyId;
            if(activePostings.filter((posting:RecordData)=>postingMatches(posting,op.cashAccountId,op.cashSide,cents(op.cashAmount),cashCurrency)).length!==1)throw new Error('Payment ledger lacks the exact cash-account posting');
            if(activePostings.filter((posting:RecordData)=>postingMatches(posting,liability!.id,ref.resource==='bills'?'debit':'credit',liabilityCents,cashCurrency)).length!==1)throw new Error('Payment ledger lacks the original subject-liability posting');
            if(fee&&activePostings.filter((posting:RecordData)=>postingMatches(posting,op.feeAccountId!,'debit',cents(fee),cashCurrency)).length!==1)throw new Error('Payment ledger lacks the explicit fee expense posting');
            const expectedPostingCount=2+(fee?1:0)+(differenceCents?1:0);
            if(activePostings.length!==expectedPostingCount)throw new Error('Payment ledger contains an unexpected fee or extra posting');
            if(differenceCents!==0){
              if(!foreign)throw new Error('Same-currency payment contains an unexplained exchange difference');
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
