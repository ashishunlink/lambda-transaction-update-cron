import { IdefaultErrorRes, IpaymentRes } from "./interface";
import { Client as PgClient } from "pg";
import { UtilsService } from "./utils.service";
import axios from "axios";
import { userAgent } from "./utils.service";
import { WalletWithScheme } from "./utils.service";

const DEFAULT_SKIP_LAST_MINUTES = 15;
const DEFAULT_CONSIDER_LAST_MINUTES = 1440;
const FROM_EVENT = "PENDING";
const FROM_STATUS = "PENDING";
const TO_STATUS = 'NOTSUCCESSFUL';
const TIMEOUT_EVENT = 'TIMEOUT';
const GATEWAY_ERROR = 'Session timeout.';
const RESPONSE_CODE_ID = 68;
const EXCLUDED_TRANSACTION_TYPE = 'REFUND';

function getIntEnv(name: string, defaultValue: number) {
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

function formatUtcTimestamp(date: Date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 19).replace('T', ' ')}.000`;
}

function buildWindow() {
  const skipLastMinutes = getIntEnv('SKIP_LAST_MINUTES', DEFAULT_SKIP_LAST_MINUTES);
  const considerLastMinutes = getIntEnv(
    'CONSIDER_LAST_MINUTES',
    DEFAULT_CONSIDER_LAST_MINUTES,
  );

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

  const client = new PgClient({
    connectionString: cleanConnectionString,
    ssl: sslConfig,
  });

  await client.connect();
  return client;
}

async function closeDatabaseConnection(client: PgClient) {
  await client.end().catch((closeError) => {
    console.error(
      JSON.stringify({
        message: 'Failed to close postgres connection',
        error: closeError.message,
      }),
    );
  });
}

async function updatePendingTransactions(client: PgClient, startDate: string, endDate: string) {
  const sqlTransaction = `
    SELECT
      to_jsonb(t) AS transaction,
      to_jsonb(m) AS merchant,
      to_jsonb(p) AS product,
      to_jsonb(l) AS locations
    FROM "Transaction" t
    LEFT JOIN "Merchant" m
      ON m."MerchantID" = t."MerchantID"
    LEFT JOIN "Locations" l
      ON l."DASMID" = t."DASMID"
    LEFT JOIN "Products" p
      ON p."ProductID" = COALESCE(t."ProductID", l."ProductID")
    WHERE t."TransactionType" NOT IN ($1)
      AND t."event" IN ($2)
      AND t."status" = $3
      AND t."CreatedAt" BETWEEN $4 AND $5
    ORDER BY t."CreatedAt" DESC
  `;

  const transaction = await client.query(sqlTransaction, [
    EXCLUDED_TRANSACTION_TYPE,
    FROM_EVENT,
    FROM_STATUS,
    startDate,
    endDate,
  ]);

  console.log("sqlTransaction=========================", sqlTransaction, [
    EXCLUDED_TRANSACTION_TYPE,
    FROM_EVENT,
    FROM_STATUS,
    startDate,
    endDate,
  ]);
  console.log("transaction.rows=========================", transaction.rows.length);

  const transactionUpdate = `
    UPDATE "Transaction"
    SET
      "event" = $1,
      "ResponseCodeID" = $2,
      "status" = $3,
      "GatewayError" = $4
    WHERE uuid = ANY($5::varchar[])
      AND "TransactionType" NOT IN ($6)
      AND "event" = $7
      AND "status" = $8
    RETURNING uuid, status, event;
  `;

  const updateResult = await client.query(transactionUpdate, [
    TIMEOUT_EVENT,
    RESPONSE_CODE_ID,
    TO_STATUS,
    GATEWAY_ERROR,
    transaction.rows.map((row) => row.transaction.uuid),
    EXCLUDED_TRANSACTION_TYPE,
    FROM_EVENT,
    FROM_STATUS,
  ]);

  for (const [index, row] of transaction.rows.entries()) {
    const uuid = row.transaction?.uuid;
    const webhookUrl = getWebhookUrl(row.transaction);
    try {
      if (!webhookUrl) {
        console.log(
          JSON.stringify({
            message: 'Skipping webhook, no URL',
            uuid,
            index,
            total: transaction.rows.length,
          }),
        );
        continue;
      }

      console.log(
        JSON.stringify({
          message: 'Sending webhook',
          uuid,
          webhookUrl,
          index,
          total: transaction.rows.length,
        }),
      );

      const dataRes = await getPaymentResponse(row);
      await callApi(webhookUrl, dataRes, uuid);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'Error calling webhook',
          uuid,
          webhookUrl,
          index,
          total: transaction.rows.length,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return {
    rowCount: updateResult.rowCount,
    rows: updateResult.rows,
  };
}

async function updatePendingSubscriptionTransactions(client: PgClient, startDate: string, endDate: string) {
  const sql = `
    UPDATE "SubscriptionTransaction"
    SET "TransactionStatus" = $1
    WHERE "TransactionStatus" IN ($2)
      AND "CreatedAt" BETWEEN $3 AND $4
  `;

  const result = await client.query(sql, [TO_STATUS, FROM_STATUS, startDate, endDate]);
  console.log(
    JSON.stringify({
      message: 'Recurring updated',
      subscriptionsUpdated: result.rowCount,
    }),
  );
  return result;
}

async function deleteOldTransactionCustomerInfo(client: PgClient, endDate: string) {
  const sql = `
    DELETE FROM "TransactionCustomerInfo"
    WHERE "CreatedAt" < $1
  `;

  const result = await client.query(sql, [endDate]);
  console.log(
    JSON.stringify({
      message: 'Deleted TransactionCustomerInfo Records',
      customerInfoDeleted: result.rowCount,
    }),
  );
  return result;
}

function getWebhookUrl(transaction: any): string {
  const url =
    transaction?.WebhookUrl ??
    transaction?.webhookurl ??
    transaction?.webhook_url ??
    "";
  return String(url).trim();
}

async function callApi(url: string, data: IpaymentRes | IdefaultErrorRes,reqid:string|null=""): Promise<void> {
  console.log({
    message : `Webhook Call Api`,
    data : {
      url : url,
      data : JSON.stringify(new UtilsService().sanitizerLog(data))
    },
    reqid : reqid
  });

  try {
    const response = await axios.post(url, data, {
      headers: {
        'User-Agent': userAgent
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log(
      JSON.stringify({
        message: 'Webhook call complete',
        url,
        uuid: reqid,
        status: response.status,
      }),
    );

    if (response.status >= 400) {
      console.error(
        JSON.stringify({
          message: 'Webhook call failed',
          url,
          uuid: reqid,
          status: response.status,
          statusText: response.statusText,
          response: response.data,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Webhook call failed',
        url,
        uuid: reqid,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function getPaymentResponse(request: any): Promise<IpaymentRes> {
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
    "address2": reqBody?.transaction?.bill_address2 || "",
    "city": reqBody?.transaction?.bill_city || "",
    "state": reqBody?.transaction?.bill_state || "",
    "postal_code": reqBody?.transaction?.bill_postal || ""
  }

  reqBody.shipping_address = {
    "country": reqBody?.transaction?.ship_country || "",
    "email": reqBody?.transaction?.ship_email || "",
    "address1": reqBody?.transaction?.ship_address || "",
    "address2": reqBody?.transaction?.ship_address2 || "",
    "city": reqBody?.transaction?.ship_city || "",
    "state": reqBody?.transaction?.ship_state || "",
    "postal_code": reqBody?.transaction?.ship_postal || "",
    "phone_number": reqBody?.transaction?.ship_phone || "",
  }

  reqBody.return_url = {
    success_url:reqBody?.transaction?.SuccessUrl,
    cancel_url: reqBody?.transaction?.DeclineUrl
  };
  
  return {
    "success": false,
    "status_code": 408,
    "is_live": false,
    "transaction_type": reqBody?.transaction?.TransactionType == "AUTHORISATION" ? "PRE_AUTH" : reqBody?.transaction?.TransactionType,
    "gateway_response": {
      "version": "1",
      "type": "ERROR",
      "message": GATEWAY_ERROR,
      "code": RESPONSE_CODE_ID.toString()
    },
    "return_url_details": reqBody?.return_url || {},
    "merchant_details": {
      "legal_name": reqBody?.merchant?.LegalName || "",
      "mid": reqBody.merchant_id || "",
      "billing_details": {
        "billing_address": reqBody.billing_address || {},
        "shipping_address": reqBody.shipping_address || {}
      },
      "device_details": {
        ...(reqBody.link_generated_ip && { "visited_ip": reqBody.link_generated_ip || "", "merchant_ip": reqBody.link_generated_ip || "" }),
        ...(reqBody.visit_ip && { "customer_ip": reqBody.visit_ip || "" }),
      }
    },
    "payment_details": {
      "amount": reqBody.amount || "",
      "response_code": RESPONSE_CODE_ID.toString(),
      "auth_code": "",
      "currency": reqBody.currency,
      "payment_method": reqBody?.transaction?.PaymentMethodType || "",
      "scheme": getSchemes(reqBody?.transaction),
      "card": getCardInfo(reqBody?.transaction),
      "additional_data":{
          "payment_data_source":{
             "type": reqBody?.transaction?.PaymentMethodType || ""
          },
          ...(reqBody?.transaction?.additional_data?.serviceOptions && { "service_options": reqBody.transaction.additional_data.serviceOptions })
        }
    },
    "transaction_details": {
      ...(reqBody?.transaction && {
        "id": reqBody.transaction.uuid,
        "ref": reqBody.transaction.ID,
        "timestamp": reqBody.transaction.TransactionDate
      }),
      "merchant_txn_ref": reqBody.merchant_txn_ref || "",
    },
    ...(reqBody?.transaction?.Subscription && {
      "subscription_details": {}
    })
  }
}

function getSchemes(transaction: any) {
  if( (transaction?.PaymentMethodType !== "card" && !WalletWithScheme.includes(transaction?.PaymentMethodType)) || (transaction?.PaymentMethodType === transaction?.Scheme )) {
    return "";
  }
  return transaction?.Scheme || "";
}

function getCardInfo(transaction: any) {
  if( transaction?.PaymentMethodType !== "card" && !WalletWithScheme.includes(transaction?.PaymentMethodType)){
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
  }
  return {
    "name": transaction?.CardHolderName || "",
    "number": transaction?.CardNumber || "",
    "exp_month": transaction?.CardExpMonth || "",
    "exp_year": String(transaction?.CardExpYear || "").slice(2)
  };
}

exports.handler = async (event = {}) => {
  const window = buildWindow();

  console.log(
    JSON.stringify({
      message: 'Executing pending transaction update lambda',
      window,
      event,
    }),
  );

  const client = await createClient();

  try {
    const pendingResult = await updatePendingTransactions(
      client,
      window.startDate,
      window.endDate,
    );
    const subscriptionResult = await updatePendingSubscriptionTransactions(
      client,
      window.startDate,
      window.endDate,
    );
    const cleanupResult = await deleteOldTransactionCustomerInfo(
      client,
      window.endDate,
    );

    const response = {
      ok: true,
      window,
      transactionsUpdated: pendingResult.rowCount,
      transactionIds: pendingResult.rows.map((row) => row.uuid),
      subscriptionsUpdated: subscriptionResult.rowCount,
      customerInfoDeleted: cleanupResult.rowCount,
    };

    console.log(JSON.stringify({ message: 'Pending transaction update complete', response }));
    return response;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Pending transaction update failed',
        error: (error as Error).message,
        stack: (error as Error).stack,
      }),
    );
    throw error;
  } finally {
    await closeDatabaseConnection(client).catch((closeError: Error) => {
      console.error(
        JSON.stringify({
          message: 'Failed to close postgres connection',
          error: closeError.message as string,
        }),
      );
    });
  }
};
