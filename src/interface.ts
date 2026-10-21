export declare enum HttpStatus {
    CONTINUE = 100,
    SWITCHING_PROTOCOLS = 101,
    PROCESSING = 102,
    EARLYHINTS = 103,
    OK = 200,
    CREATED = 201,
    ACCEPTED = 202,
    NON_AUTHORITATIVE_INFORMATION = 203,
    NO_CONTENT = 204,
    RESET_CONTENT = 205,
    PARTIAL_CONTENT = 206,
    MULTI_STATUS = 207,
    ALREADY_REPORTED = 208,
    CONTENT_DIFFERENT = 210,
    AMBIGUOUS = 300,
    MOVED_PERMANENTLY = 301,
    FOUND = 302,
    SEE_OTHER = 303,
    NOT_MODIFIED = 304,
    TEMPORARY_REDIRECT = 307,
    PERMANENT_REDIRECT = 308,
    BAD_REQUEST = 400,
    UNAUTHORIZED = 401,
    PAYMENT_REQUIRED = 402,
    FORBIDDEN = 403,
    NOT_FOUND = 404,
    METHOD_NOT_ALLOWED = 405,
    NOT_ACCEPTABLE = 406,
    PROXY_AUTHENTICATION_REQUIRED = 407,
    REQUEST_TIMEOUT = 408,
    CONFLICT = 409,
    GONE = 410,
    LENGTH_REQUIRED = 411,
    PRECONDITION_FAILED = 412,
    PAYLOAD_TOO_LARGE = 413,
    URI_TOO_LONG = 414,
    UNSUPPORTED_MEDIA_TYPE = 415,
    REQUESTED_RANGE_NOT_SATISFIABLE = 416,
    EXPECTATION_FAILED = 417,
    I_AM_A_TEAPOT = 418,
    MISDIRECTED = 421,
    UNPROCESSABLE_ENTITY = 422,
    LOCKED = 423,
    FAILED_DEPENDENCY = 424,
    PRECONDITION_REQUIRED = 428,
    TOO_MANY_REQUESTS = 429,
    UNRECOVERABLE_ERROR = 456,
    INTERNAL_SERVER_ERROR = 500,
    NOT_IMPLEMENTED = 501,
    BAD_GATEWAY = 502,
    SERVICE_UNAVAILABLE = 503,
    GATEWAY_TIMEOUT = 504,
    HTTP_VERSION_NOT_SUPPORTED = 505,
    INSUFFICIENT_STORAGE = 507,
    LOOP_DETECTED = 508
}


export const gatewayResponseTransactionType = {
    CAPTURE : "CAPTURE", 
    PRE_AUTH: 'PRE_AUTH',
    REFUND:"REFUND",
    CANCELLED:"CANCELLED",
    VOID:"VOID"
};


export const gatewayResponseType = {
    INF: "INFO",
    ERR: "ERROR",
    VAL: "VALIDATION"
};





export interface IdefaultErrorRes {
    statusCode?: HttpStatus|string;
    message?: string;
    messageCode?: string;
    type?:string;
}


export type GatewayResponseTransactionType = (typeof gatewayResponseTransactionType)[keyof typeof gatewayResponseTransactionType];

export type GatewayResponseType = (typeof gatewayResponseType)[keyof typeof gatewayResponseType];


export interface IpaymentRes {
    "success": boolean;
    "status_code": HttpStatus;
    "is_live": boolean;
    "transaction_type": GatewayResponseTransactionType;
    "gateway_response": {
        "version": string;
        "type": GatewayResponseType;
        "message": string;
        "code": string;
    };
    "return_url_details"?: {
        "webhook_url"?: string;
        "success_url"?: string;
        "decline_url"?: string;
    };
    "merchant_details"?: {
        "legal_name"?: string;
        "mid"?: string;
        "merchant_txn_ref"?: string;
        "billing_details"?: {
            "billing_address"?: {
                "country"?: string;
                "email"?: string;
                "address1"?: string;
                "phone_number"?: string;
                "phone"?:string;
                "city"?: string;
                "state"?: string;
                "postal_code"?: string;
  
            };
            "shipping_address"?: {
                "country"?: string;
                "email"?: string;
                "address1"?: string;
                "phone_number"?: string;
                "phone"?:string;
                "city"?: string;
                "state"?: string;
                "postal_code"?: string;
  
            }
        };
        "device_details"?: {
            "visited_ip"?: string;
            "merchant_ip"?: string;
            "customer_ip"?: string;
        }
    };
    "recurring_details"?: {
        "plan_name"?: string;
        "interval_type"?: string;
        "interval_duration"?: number;
        "cycle"?: number;
    };
    "payment_details"?: {
        "amount"?: string;
        "response_code"?: string | number;
        "auth_code"?: string;
        "currency"?: string;
        "payment_method"?: string;
        "scheme"?: string;
        "card"?: {
            "name"?: string;
            "number"?: string;
            "exp_month"?: string;
            "exp_year"?: string;
        },
        "additional_data"?:{
            "payment_data_source"?:{
                "type"?:string
            }
        },
        "responseDescription"?: string;
    };
    "transaction_details"?: {
        "id"?: string;
        "ref"?: string;
        "timestamp"?: string;
        "merchant_txn_ref"?: string;
        "stored_payment_method_id"?:string;
        "notes"?: string;
    };
    "risk-details"?: {
        "risk_score"?: string;
    };
  }