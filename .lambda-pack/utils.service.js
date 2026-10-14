"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletWithScheme = exports.WalletSchemes = exports.userAgent = exports.UtilsService = void 0;
const common_1 = require("@nestjs/common");
const traverse = require('traverse');
let UtilsService = class UtilsService {
    uuidRegex = new RegExp(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    hasConfidentialData(str) {
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
        ];
        return keys.some((regex) => { return regex.test(str); });
    }
    hasCreditcard(str) {
        // traverse visits objects/arrays too; RegExp.test would try to stringify them
        // and throws "Cannot convert object to primitive value" for prototype-less objects.
        if (typeof str !== "string" && typeof str !== "number")
            return false;
        const values = [
            /^\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}$/ // credit card number
        ];
        return values.some((regex) => { return regex.test(String(str)); });
    }
    sanitizerLog(obj) {
        const hasConfidentialData = this.hasConfidentialData;
        const hasCreditcard = this.hasCreditcard;
        let mutatedObj = traverse(obj).map(function (val) {
            if (hasConfidentialData(this.key) || hasCreditcard(val))
                this.update("******");
        });
        return mutatedObj;
    }
};
exports.UtilsService = UtilsService;
exports.UtilsService = UtilsService = __decorate([
    (0, common_1.Injectable)({ scope: common_1.Scope.REQUEST })
], UtilsService);
exports.userAgent = 'PO/3.0';
var WalletSchemes;
(function (WalletSchemes) {
    WalletSchemes["applepay"] = "applePay";
    WalletSchemes["googlepay"] = "googlePay";
    WalletSchemes["alipay"] = "alipay";
    WalletSchemes["gcash"] = "gcash";
    WalletSchemes["paypay"] = "paypay";
    WalletSchemes["konbini"] = "konbini";
    WalletSchemes["payeasy"] = "payeasy";
    WalletSchemes["daspay"] = "dasPay";
    WalletSchemes["qrph"] = "qrph";
})(WalletSchemes || (exports.WalletSchemes = WalletSchemes = {}));
exports.WalletWithScheme = [
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
//# sourceMappingURL=utils.service.js.map