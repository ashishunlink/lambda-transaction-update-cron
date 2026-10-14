import { Injectable, Scope } from '@nestjs/common';
import * as crypto from 'crypto';
const traverse = require('traverse')
@Injectable({ scope: Scope.REQUEST })
export class UtilsService {
  uuidRegex = new RegExp(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  hasConfidentialData (str: string): boolean {
    const keys = [
      // generic
      /passw(or)?d/i,
      /^pw$/,
      /^pass$/i,
      /secret/i,
      /token/i,
      /api[-._]?key/i,
      /session[-._]?id/i,
      /cvc/i,
      /securityCode/i,
      /^number$/,
      /PAN/i,
      // specific
      /^connect\.sid$/, // https://github.com/expressjs/session
      /^\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}$/, // credit card number
       /stored_payment_method_id/
    ]
    return keys.some((regex) => { return regex.test(str) })
  }
  
  hasCreditcard(str: string): boolean {
    // traverse visits objects/arrays too; RegExp.test would try to stringify them
    // and throws "Cannot convert object to primitive value" for prototype-less objects.
    if (typeof str !== "string" && typeof str !== "number") return false;
    const values = [
      /^\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}$/ // credit card number
    ]
    return values.some((regex) => { return regex.test(String(str)) });
  }


  sanitizerLog(obj: any): any {
    const hasConfidentialData = this.hasConfidentialData;
    const hasCreditcard = this.hasCreditcard;
    let mutatedObj = traverse(obj).map(function (val: any) {
      if (hasConfidentialData(this.key as string) || hasCreditcard(val as string)) this.update("******")
    })
    return mutatedObj;
  }
}

export const userAgent = 'PO/3.0';

export enum WalletSchemes {
  applepay="applePay",
  googlepay="googlePay",
  alipay="alipay",
  gcash="gcash",
  paypay="paypay",
  konbini="konbini",
  payeasy="payeasy",
  daspay="dasPay",
  qrph="qrph"
}
export const WalletWithScheme = [
  WalletSchemes.applepay.toLocaleLowerCase(),
  WalletSchemes.googlepay.toLocaleLowerCase(),
  WalletSchemes.daspay.toLocaleLowerCase(),
  WalletSchemes.alipay.toLocaleLowerCase(),
  WalletSchemes.gcash.toLocaleLowerCase(),
  WalletSchemes.paypay.toLocaleLowerCase(),
  WalletSchemes.konbini.toLocaleLowerCase(),
  WalletSchemes.payeasy.toLocaleLowerCase(),
  WalletSchemes.qrph.toLocaleLowerCase()
];


