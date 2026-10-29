"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const utils_service_1 = require("./utils.service");
const axios_1 = __importDefault(require("axios"));
const utils_service_2 = require("./utils.service");
const DEFAULT_SKIP_LAST_MINUTES = 15;
const DEFAULT_CONSIDER_LAST_MINUTES = 1440;
const FROM_EVENT = "PENDING";
const FROM_STATUS = "PENDING";
let TO_STATUS = 'NOTSUCCESSFUL';
let TIMEOUT_EVENT = 'TIMEOUT';
let GATEWAY_ERROR = 'Session timeout.';
let RESPONSE_CODE_ID = -1;
const EXCLUDED_TRANSACTION_TYPE = 'REFUND';
function getIntEnv(name, defaultValue) {
    const raw = process.env[name];
    if (raw == null || raw === '') {
        return defaultValue;
    }
    const value = Number.parseInt(raw, 10);
    if (Number.isNaN(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer.`);
    }
    return value;
}
function formatUtcTimestamp(date) {
    const iso = date.toISOString();
    return `${iso.slice(0, 19).replace('T', ' ')}.000`;
}
function formatTransactionTimestamp(value) {
    if (value == null || value === '') {
        return '';
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? '' : value.toISOString();
    }
    let raw = String(value).trim();
    if (!raw.includes('T') && raw.includes(' ')) {
        raw = raw.replace(' ', 'T');
    }
    raw = raw.replace(/([+-]\d{2})$/, '$1:00');
    raw = raw.replace(/([+-]\d{4})$/, (_, offset) => `${offset.slice(0, 3)}:${offset.slice(3)}`);
    const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
    const date = new Date(hasZone ? raw : `${raw}Z`);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }
    return date.toISOString();
}
function buildWindow() {
    const skipLastMinutes = getIntEnv('SKIP_LAST_MINUTES', DEFAULT_SKIP_LAST_MINUTES);
    const considerLastMinutes = getIntEnv('CONSIDER_LAST_MINUTES', DEFAULT_CONSIDER_LAST_MINUTES);
    const now = new Date();
    const startDate = new Date(now.getTime() - considerLastMinutes * 60 * 1000);
    const endDate = new Date(now.getTime() - skipLastMinutes * 60 * 1000);
    return {
        skipLastMinutes,
        considerLastMinutes,
        startDate: formatUtcTimestamp(startDate),
        endDate: formatUtcTimestamp(endDate),
    };
}
async function createClient() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error("DATABASE_URL is not set");
    }
    const cleanConnectionString = connectionString.split('?')[0];
    const sslConfig = { rejectUnauthorized: false };
    const client = new pg_1.Client({
        connectionString: cleanConnectionString,
        ssl: sslConfig,
    });
    await client.connect();
    return client;
}
async function closeDatabaseConnection(client) {
    await client.end().catch((closeError) => {
        console.error(JSON.stringify({
            message: 'Failed to close postgres connection',
            error: closeError.message,
        }));
    });
}
async function updatePendingTransactions(client, startDate, endDate) {
    console.log("updatePendingTransactions=========================", startDate, endDate);
    const sqlTransaction = `
    SELECT
      to_jsonb(t) AS transaction,
      to_jsonb(m) AS merchant,
      to_jsonb(p) AS product,
      to_jsonb(l) AS locations
    FROM "Transaction" t
    LEFT JOIN "Locations" l
      ON l."DASMID" = t."DASMID"
    LEFT JOIN "Merchant" m
      ON m."MerchantID" = l."MerchantID"
    LEFT JOIN "Products" p
      ON p."ProductID" = COALESCE(t."ProductID", l."ProductID")
    WHERE t."TransactionType" NOT IN ($1)
      AND t."event" IN ($2)
      AND t."status" = $3
      AND t."CreatedAt" BETWEEN $4 AND $5
      AND t."Scheme" != $6
    ORDER BY t."CreatedAt" DESC
  `;
    const transaction = await client.query(sqlTransaction, [
        EXCLUDED_TRANSACTION_TYPE,
        FROM_EVENT,
        FROM_STATUS,
        startDate,
        endDate,
        "paynow",
    ]);
    const rows = uniqueTransactionRows(transaction.rows);
    console.log(JSON.stringify({
        message: 'Pending transactions selected',
        selected: transaction.rows.length,
        unique: rows.length,
        transactions: rows.map((row) => ({
            uuid: row.transaction?.uuid,
            webhookUrl: getWebhookUrl(row.transaction),
        })),
    }));
    const transactionUpdate = `
    UPDATE "Transaction"
    SET
      "event" = $1,
      "ResponseCodeID" = $2,
      "status" = $3,
      "GatewayError" = $4,
      "UpdatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE uuid = ANY($5::varchar[])
      AND "TransactionType" NOT IN ($6)
      AND "event" = $7
      AND "status" = $8
    RETURNING uuid, status, event;
  `;
    const updatedRows = [];
    let databaseQueue = Promise.resolve();
    const enqueueDatabase = (task) => {
        const run = databaseQueue.then(task, task);
        databaseQueue = run.then(() => undefined, () => undefined);
        return run;
    };
    await eachWithConcurrency(rows, 10, async (row, index) => {
        const uuid = row.transaction?.uuid;
        const webhookUrl = getWebhookUrl(row.transaction);
        if (!uuid) {
            return;
        }
        try {
            if (!webhookUrl) {
                console.log(JSON.stringify({
                    message: 'Skipping webhook, no URL',
                    uuid,
                    index,
                    total: rows.length,
                }));
            }
            else {
                console.log(JSON.stringify({
                    message: 'Sending webhook',
                    uuid,
                    webhookUrl,
                    index,
                    total: rows.length,
                }));
                const dataRes = await getPaymentResponse(row);
                await callApi(webhookUrl, dataRes, uuid);
            }
        }
        catch (error) {
            console.error(JSON.stringify({
                message: 'Error calling webhook',
                uuid,
                webhookUrl,
                index,
                total: rows.length,
                error: error instanceof Error ? error.message : String(error),
            }));
        }
        const updateResult = await enqueueDatabase(() => client.query(transactionUpdate, [
            TIMEOUT_EVENT,
            RESPONSE_CODE_ID,
            TO_STATUS,
            GATEWAY_ERROR,
            [uuid],
            EXCLUDED_TRANSACTION_TYPE,
            FROM_EVENT,
            FROM_STATUS,
        ]));
        updatedRows.push(...updateResult.rows);
    });
    return {
        rowCount: updatedRows.length,
        rows: updatedRows,
    };
}
async function updatePendingUOBTransactions(client, startDate, endDate) {
    console.log("updatePendingUOBTransactions=========================", startDate, endDate);
    const sqlTransaction = `
    SELECT
      to_jsonb(t) AS transaction,
      to_jsonb(m) AS merchant,
      to_jsonb(p) AS product,
      to_jsonb(l) AS locations
    FROM "Transaction" t
    LEFT JOIN "Locations" l
      ON l."DASMID" = t."DASMID"
    LEFT JOIN "Merchant" m
      ON m."MerchantID" = l."MerchantID"
    LEFT JOIN "Products" p
      ON p."ProductID" = COALESCE(t."ProductID", l."ProductID")
    WHERE t."TransactionType" NOT IN ($1)
      AND t."event" IN ($2)
      AND t."status" = $3
      AND t."CreatedAt" BETWEEN $4 AND $5
      AND t."Scheme" = $6
    ORDER BY t."CreatedAt" DESC
  `;
    const transaction = await client.query(sqlTransaction, [
        EXCLUDED_TRANSACTION_TYPE,
        FROM_EVENT,
        FROM_STATUS,
        startDate,
        endDate,
        "paynow",
    ]);
    const rows = uniqueTransactionRows(transaction.rows);
    console.log(JSON.stringify({
        message: 'Pending transactions selected',
        selected: transaction.rows.length,
        unique: rows.length,
        transactions: rows.map((row) => ({
            uuid: row.transaction?.uuid,
            webhookUrl: getWebhookUrl(row.transaction),
        })),
    }));
    const transactionUpdate = `
    UPDATE "Transaction"
    SET
      "event" = $1,
      "ResponseCodeID" = $2,
      "status" = $3,
      "GatewayError" = $4,
      "UpdatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE uuid = ANY($5::varchar[])
      AND "TransactionType" NOT IN ($6)
      AND "event" = $7
      AND "status" = $8
    RETURNING uuid, status, event;
  `;
    const updatedRows = [];
    let databaseQueue = Promise.resolve();
    const enqueueDatabase = (task) => {
        const run = databaseQueue.then(task, task);
        databaseQueue = run.then(() => undefined, () => undefined);
        return run;
    };
    await eachWithConcurrency(rows, 10, async (row, index) => {
        const uuid = row.transaction?.uuid;
        const webhookUrl = getWebhookUrl(row.transaction);
        if (!uuid) {
            return;
        }
        //Get UOB Transaction Status from UOB Service
        const uobTransactionStatus = await getUOBTransactionStatus(row.transaction?.ID, row.transaction?.CreatedAt.split("T")[0]);
        //Check if transactions key not present in account object, then transaction is not found in UOB
        if (uobTransactionStatus?.account?.description === "No record found from search") {
            TO_STATUS = "NOTSUCCESSFUL";
            TIMEOUT_EVENT = "TIMEOUT";
            RESPONSE_CODE_ID = -1;
            GATEWAY_ERROR = "Session timeout.";
        }
        if (uobTransactionStatus?.account?.transactions?.length > 0) {
            TO_STATUS = "SUCCESSFUL";
            TIMEOUT_EVENT = "CAPTURED";
            RESPONSE_CODE_ID = 0;
            GATEWAY_ERROR = "";
        }
        try {
            if (!webhookUrl) {
                console.log(JSON.stringify({
                    message: 'Skipping webhook, no URL',
                    uuid,
                    index,
                    total: rows.length,
                }));
            }
            else {
                console.log(JSON.stringify({
                    message: 'Sending webhook',
                    uuid,
                    webhookUrl,
                    index,
                    total: rows.length,
                }));
                const dataRes = await getUOBPaymentResponse(row);
                await callApi(webhookUrl, dataRes, uuid);
            }
        }
        catch (error) {
            console.error(JSON.stringify({
                message: 'Error calling webhook',
                uuid,
                webhookUrl,
                index,
                total: rows.length,
                error: error instanceof Error ? error.message : String(error),
            }));
        }
        const updateResult = await enqueueDatabase(() => client.query(transactionUpdate, [
            TIMEOUT_EVENT,
            RESPONSE_CODE_ID,
            TO_STATUS,
            GATEWAY_ERROR,
            [uuid],
            EXCLUDED_TRANSACTION_TYPE,
            FROM_EVENT,
            FROM_STATUS,
        ]));
        updatedRows.push(...updateResult.rows);
    });
    return {
        rowCount: updatedRows.length,
        rows: updatedRows,
    };
}
async function updatePendingSubscriptionTransactions(client, startDate, endDate) {
    const sql = `
    UPDATE "SubscriptionTransaction"
    SET "TransactionStatus" = $1
    WHERE "TransactionStatus" IN ($2)
      AND "CreatedAt" BETWEEN $3 AND $4
  `;
    const result = await client.query(sql, [TO_STATUS, FROM_STATUS, startDate, endDate]);
    console.log(JSON.stringify({
        message: 'Recurring updated',
        subscriptionsUpdated: result.rowCount,
    }));
    return result;
}
async function deleteOldTransactionCustomerInfo(client, endDate) {
    const sql = `
    DELETE FROM "TransactionCustomerInfo"
    WHERE "CreatedAt" < $1
  `;
    const result = await client.query(sql, [endDate]);
    console.log(JSON.stringify({
        message: 'Deleted TransactionCustomerInfo Records',
        customerInfoDeleted: result.rowCount,
    }));
    return result;
}
function uniqueTransactionRows(rows) {
    const seen = new Set();
    const unique = [];
    for (const row of rows) {
        const uuid = row?.transaction?.uuid;
        if (uuid == null || uuid === '' || seen.has(String(uuid))) {
            continue;
        }
        seen.add(String(uuid));
        unique.push(row);
    }
    return unique;
}
async function eachWithConcurrency(items, limit, worker) {
    if (items.length === 0) {
        return;
    }
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            await worker(items[index], index);
        }
    });
    await Promise.all(workers);
}
function getWebhookUrl(transaction) {
    const url = transaction?.WebhookUrl ??
        transaction?.WebhookURL ??
        transaction?.webhookurl ??
        transaction?.webhook_url ??
        "";
    return String(url).trim();
}
async function callApi(url, data, reqid = "") {
    console.log({
        message: `Webhook Call Api`,
        data: {
            url: url,
            data: JSON.stringify(new utils_service_1.UtilsService().sanitizerLog(data))
        },
        reqid: reqid
    });
    try {
        const response = await axios_1.default.post(url, data, {
            headers: {
                'User-Agent': utils_service_2.userAgent
            },
            timeout: 15000,
            validateStatus: () => true,
        });
        console.log(JSON.stringify({
            message: 'Webhook call complete',
            url,
            uuid: reqid,
            status: response.status,
        }));
        if (response.status >= 400) {
            console.error(JSON.stringify({
                message: 'Webhook call failed',
                url,
                uuid: reqid,
                status: response.status,
                statusText: response.statusText,
                response: response.data,
            }));
            //Save Webhook in Logs
            await saveResponse(reqid, "WEBHOOK", { url: url, payload: data, response: "failed" });
        }
        //Save Webhook in Logs
        await saveResponse(reqid, "WEBHOOK", { url: url, payload: data, response: "success" });
    }
    catch (error) {
        console.error(JSON.stringify({
            message: 'Webhook call failed',
            url,
            uuid: reqid,
            error: error instanceof Error ? error.message : String(error),
        }));
        //Save Webhook in Logs
        await saveResponse(reqid, "WEBHOOK", { url: url, payload: data, response: "failed" });
    }
}
async function saveResponse(transactionId, action, response) {
    if (!transactionId) {
        return;
    }
    this.httpService.post(`${process.env.INT_API_BASE_PATH}/transactions/save-transaction-response`, {
        transactionId: transactionId,
        "action": action,
        response: this.utilsService.maskKeys(response, ["stored_payment_method_id"])
    }, {
        headers: {
            'api-int-key': ""
        }
    }).subscribe({
        next: (response) => { },
        error: (err) => { }
    });
    return;
}
async function getUOBTransactionStatus(transactionID, createdAt) {
    const url = `${process.env.UOB_SERVICE_PATH}/api/v1/uob/account-transaction-history-search`;
    const transactionDT = `${createdAt.split("-")[2]}${createdAt.split("-")[1]}${createdAt.split("-")[0]}`;
    const data = {
        "fromDate": transactionDT,
        "toDate": transactionDT,
        "fromTime": "00:00",
        "toTime": "23:59",
        "transactionText": transactionID.toString()
    };
    console.log("Request Payload UOB Status=========================", data);
    const response = await axios_1.default.post(url, data);
    return response.data;
}
async function getPaymentResponse(request) {
    let reqBody = request;
    if (request.transaction) {
        reqBody["auto_capture"] = (request.transaction.TransactionType == "AUTHORISATION") ? false : true;
        reqBody["return_url"] = (reqBody?.return_url) ? reqBody?.return_url : {};
        reqBody["merchant_id"] = request.transaction.DASMID;
        reqBody["billing_address"] = (reqBody?.billing_address) ? reqBody?.billing_address : (request.transaction?.HPP?.billing_address || {});
        reqBody["shipping_address"] = (reqBody?.shipping_address) ? reqBody?.shipping_address : (request.transaction?.HPP?.shipping_address || {});
        reqBody["amount"] = (reqBody?.amount) ? reqBody?.amount : (request.transaction?.amount);
        reqBody["currency"] = (reqBody?.currency) ? reqBody?.currency : (request.transaction?.CurrencyCode);
        reqBody["merchant_txn_ref"] = (reqBody?.merchant_txn_ref) ? reqBody?.merchant_txn_ref : (request.transaction?.MerchantRefID || "");
    }
    reqBody.billing_address = {
        "country": reqBody?.transaction?.bill_country || "",
        "email": reqBody?.transaction?.bill_email || "",
        "address1": reqBody?.transaction?.bill_address1 || "",
        //"address2": reqBody?.transaction?.bill_address2 || "",
        "city": reqBody?.transaction?.bill_city || "",
        "state": reqBody?.transaction?.bill_state || "",
        "postal_code": reqBody?.transaction?.bill_postal || "",
        "phone_number": reqBody?.transaction?.bill_phone || "",
    };
    reqBody.shipping_address = {
        "country": reqBody?.transaction?.ship_country || "",
        "email": reqBody?.transaction?.ship_email || "",
        "address1": reqBody?.transaction?.ship_address || "",
        //"address2": reqBody?.transaction?.ship_address2 || "",
        "city": reqBody?.transaction?.ship_city || "",
        "state": reqBody?.transaction?.ship_state || "",
        "postal_code": reqBody?.transaction?.ship_postal || "",
        "phone_number": reqBody?.transaction?.ship_phone || "",
    };
    reqBody.return_url = {
        success_url: reqBody?.transaction?.SuccessUrl,
        cancel_url: reqBody?.transaction?.DeclineUrl
    };
    return {
        "success": false,
        "status_code": 400,
        "is_live": false,
        "transaction_type": reqBody?.transaction?.TransactionType == "AUTHORISATION" ? "PRE_AUTH" : "CAPTURE",
        "gateway_response": {
            "version": "1",
            "type": "ERROR",
            "message": GATEWAY_ERROR,
            "code": "ERR0002"
        },
        //"return_url_details": reqBody?.return_url || {},
        "merchant_details": {
            "legal_name": reqBody?.merchant?.LegalName || "",
            "mid": reqBody.merchant_id || "",
            "billing_details": {
                "billing_address": reqBody.billing_address || {},
                "shipping_address": reqBody.shipping_address || {}
            },
            "merchant_txn_ref": reqBody.merchant_txn_ref || ""
            /*"device_details": {
              ...(reqBody.link_generated_ip && { "visited_ip": reqBody.link_generated_ip || "", "merchant_ip": reqBody.link_generated_ip || "" }),
              ...(reqBody.visit_ip && { "customer_ip": reqBody.visit_ip || "" }),
            }*/
        },
        "payment_details": {
            "amount": reqBody.amount || "",
            "response_code": RESPONSE_CODE_ID,
            "auth_code": null,
            "currency": reqBody.currency,
            "payment_method": reqBody?.transaction?.PaymentMethodType || "card",
            "scheme": getSchemes(reqBody?.transaction),
            "card": getCardInfo(reqBody?.transaction),
            "additional_data": {
                "payment_data_source": {
                    "type": reqBody?.transaction?.PaymentMethodType || "card"
                },
                ...(reqBody?.transaction?.additional_data?.serviceOptions && { "service_options": reqBody.transaction.additional_data.serviceOptions })
            },
            "responseDescription": reqBody?.transaction?.GatewayError || ""
        },
        "transaction_details": {
            ...(reqBody?.transaction && {
                "id": reqBody.transaction.uuid,
                "ref": reqBody.transaction.ID,
                "merchant_txn_ref": reqBody.merchant_txn_ref || "",
                "timestamp": formatTransactionTimestamp(reqBody.transaction.TransactionDate)
            })
        },
        ...(reqBody?.transaction?.Subscription && {
            "subscription_details": {}
        }),
        "risk-details": {
            "risk_score": null
        }
    };
}
async function getUOBPaymentResponse(request) {
    let reqBody = request;
    if (request.transaction) {
        reqBody["auto_capture"] = (request.transaction.TransactionType == "AUTHORISATION") ? false : true;
        reqBody["return_url"] = (reqBody?.return_url) ? reqBody?.return_url : {};
        reqBody["merchant_id"] = request.transaction.DASMID;
        reqBody["billing_address"] = (reqBody?.billing_address) ? reqBody?.billing_address : (request.transaction?.HPP?.billing_address || {});
        reqBody["shipping_address"] = (reqBody?.shipping_address) ? reqBody?.shipping_address : (request.transaction?.HPP?.shipping_address || {});
        reqBody["amount"] = (reqBody?.amount) ? reqBody?.amount : (request.transaction?.amount);
        reqBody["currency"] = (reqBody?.currency) ? reqBody?.currency : (request.transaction?.CurrencyCode);
        reqBody["merchant_txn_ref"] = (reqBody?.merchant_txn_ref) ? reqBody?.merchant_txn_ref : (request.transaction?.MerchantRefID || "");
    }
    reqBody.billing_address = {
        "country": reqBody?.transaction?.bill_country || "",
        "email": reqBody?.transaction?.bill_email || "",
        "address1": reqBody?.transaction?.bill_address1 || "",
        //"address2": reqBody?.transaction?.bill_address2 || "",
        "city": reqBody?.transaction?.bill_city || "",
        "state": reqBody?.transaction?.bill_state || "",
        "postal_code": reqBody?.transaction?.bill_postal || "",
        "phone_number": reqBody?.transaction?.bill_phone || "",
    };
    reqBody.shipping_address = {
        "country": reqBody?.transaction?.ship_country || "",
        "email": reqBody?.transaction?.ship_email || "",
        "address1": reqBody?.transaction?.ship_address || "",
        //"address2": reqBody?.transaction?.ship_address2 || "",
        "city": reqBody?.transaction?.ship_city || "",
        "state": reqBody?.transaction?.ship_state || "",
        "postal_code": reqBody?.transaction?.ship_postal || "",
        "phone_number": reqBody?.transaction?.ship_phone || "",
    };
    reqBody.return_url = {
        success_url: reqBody?.transaction?.SuccessUrl,
        cancel_url: reqBody?.transaction?.DeclineUrl
    };
    return {
        "success": false,
        "status_code": 400,
        "is_live": false,
        "transaction_type": reqBody?.transaction?.TransactionType == "AUTHORISATION" ? "PRE_AUTH" : "CAPTURE",
        "gateway_response": {
            "version": "1",
            "type": "ERROR",
            "message": GATEWAY_ERROR,
            "code": "ERR0002"
        },
        //"return_url_details": reqBody?.return_url || {},
        "merchant_details": {
            "legal_name": reqBody?.merchant?.LegalName || "",
            "mid": reqBody.merchant_id || "",
            "billing_details": {
                "billing_address": reqBody.billing_address || {},
                "shipping_address": reqBody.shipping_address || {}
            },
            "merchant_txn_ref": reqBody.merchant_txn_ref || ""
            /*"device_details": {
              ...(reqBody.link_generated_ip && { "visited_ip": reqBody.link_generated_ip || "", "merchant_ip": reqBody.link_generated_ip || "" }),
              ...(reqBody.visit_ip && { "customer_ip": reqBody.visit_ip || "" }),
            }*/
        },
        "payment_details": {
            "amount": reqBody.amount || "",
            "response_code": RESPONSE_CODE_ID,
            "auth_code": null,
            "currency": reqBody.currency,
            "payment_method": reqBody?.transaction?.PaymentMethodType || "card",
            "scheme": getSchemes(reqBody?.transaction),
            "card": getCardInfo(reqBody?.transaction),
            "additional_data": {
                "payment_data_source": {
                    "type": "paynow"
                },
                ...(reqBody?.transaction?.additional_data?.serviceOptions && { "service_options": reqBody.transaction.additional_data.serviceOptions })
            },
            "responseDescription": reqBody?.transaction?.GatewayError || ""
        },
        "transaction_details": {
            ...(reqBody?.transaction && {
                "id": reqBody.transaction.uuid,
                "ref": reqBody.transaction.ID,
                "merchant_txn_ref": reqBody.merchant_txn_ref || "",
                "timestamp": formatTransactionTimestamp(reqBody.transaction.TransactionDate)
            })
        },
        ...(reqBody?.transaction?.Subscription && {
            "subscription_details": {}
        }),
        "risk-details": {
            "risk_score": null
        }
    };
}
function getSchemes(transaction) {
    /*if( (transaction?.PaymentMethodType !== "card" && !WalletWithScheme.includes(transaction?.PaymentMethodType)) || (transaction?.PaymentMethodType === transaction?.Scheme )) {
      return "";
    }*/
    return transaction?.Scheme || "";
}
function getCardInfo(transaction) {
    /*if( transaction?.PaymentMethodType !== "card" && !WalletWithScheme.includes(transaction?.PaymentMethodType)){
      return {
        "name": "",
        "number": "",
        "exp_month": "",
        "exp_year": ""
      };
    }else if(WalletWithScheme.includes(transaction?.PaymentMethodType) && transaction?.CardNumber === "000000******0000") {
      return {
        "name": "",
        "number": "",
        "exp_month": "",
        "exp_year": ""
      };
    }*/
    return {
        "name": transaction?.CardHolderName || "",
        "number": transaction?.CardNumber || "",
        "exp_month": transaction?.CardExpMonth || "",
        "exp_year": String(transaction?.CardExpYear || "").slice(2)
    };
}
exports.handler = async (event = {}) => {
    const window = buildWindow();
    console.log(JSON.stringify({
        message: 'Executing pending transaction update lambda',
        window,
        event,
    }));
    const client = await createClient();
    try {
        const pendingResult = await updatePendingTransactions(client, window.startDate, window.endDate);
        const pendingUOBResult = await updatePendingUOBTransactions(client, window.startDate, window.endDate);
        const subscriptionResult = await updatePendingSubscriptionTransactions(client, window.startDate, window.endDate);
        const cleanupResult = await deleteOldTransactionCustomerInfo(client, window.endDate);
        const response = {
            ok: true,
            window,
            transactionsUpdated: pendingResult.rowCount,
            transactionsUOBUpdated: pendingUOBResult.rowCount,
            transactionIds: pendingResult.rows.map((row) => row.uuid),
            subscriptionsUpdated: subscriptionResult.rowCount,
            customerInfoDeleted: cleanupResult.rowCount,
        };
        console.log(JSON.stringify({ message: 'Pending transaction update complete', response }));
        return response;
    }
    catch (error) {
        console.error(JSON.stringify({
            message: 'Pending transaction update failed',
            error: error.message,
            stack: error.stack,
        }));
        throw error;
    }
    finally {
        await closeDatabaseConnection(client).catch((closeError) => {
            console.error(JSON.stringify({
                message: 'Failed to close postgres connection',
                error: closeError.message,
            }));
        });
    }
};
//# sourceMappingURL=index.js.map