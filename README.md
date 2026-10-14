# Pending Transaction Update Lambda

This folder contains a Node.js Lambda replacement for `update-pending-transactions.sh`. It is intended to run on a recurring AWS EventBridge Scheduler schedule and performs the same three database operations:

1. Update stale `Transaction` rows from `PENDING` to `NOTSUCCESSFUL`
2. Update stale `SubscriptionTransaction` rows from `PENDING` to `NOTSUCCESSFUL`
3. Delete old `TransactionCustomerInfo` rows older than the cutoff window

## Files

- `src/index.js` - Lambda handler
- `package.json` - runtime dependency metadata
- `template.yaml` - AWS SAM template for Lambda, IAM, and EventBridge Scheduler
- `.env.example` - local environment variable example
- `samconfig.toml.example` - example guided deploy settings
- `update-pending-transactions.sh` - original shell reference

## Environment variables

Required:

- `DB_HOST`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`

Optional:

- `DB_PORT` (default `5432`)
- `DB_SSL` (`true` or `false`, default `false`)
- `SKIP_LAST_MINUTES` (default `15`)
- `CONSIDER_LAST_MINUTES` (default `1440`)

## Local install

```bash
cd lambda-transaction-update-cron
npm install
npm run check
```

## Manual zip deploy

1. Install dependencies:

```bash
cd lambda-transaction-update-cron
npm install --omit=dev
```

2. Create a zip package containing `src/`, `package.json`, and `node_modules/`.
3. In AWS Lambda, create a new Node.js 20 function and upload the zip.
4. Set the environment variables from `.env.example`.
5. If the RDS instance is private, attach the Lambda to the correct VPC subnets and security group.
6. Create an EventBridge Scheduler schedule that targets the Lambda.

Recommended schedule: `rate(15 minutes)`.

## AWS SAM deploy

```bash
cd lambda-transaction-update-cron
npm install
sam build
sam deploy --guided
```

During guided deploy, provide:

- database host, name, user, password
- `DBSSL=true` if your RDS setup requires SSL
- `VpcSubnetIds` and `VpcSecurityGroupIds` when the database is only reachable inside a VPC
- a schedule expression such as `rate(15 minutes)`

The template creates:

- the Lambda function
- an IAM role for Lambda execution
- an IAM role for EventBridge Scheduler invocation
- an `AWS::Scheduler::Schedule` resource that invokes the Lambda

## Notes

- Credentials are intentionally not hardcoded; use Lambda env vars or move to Secrets Manager later.
- The original shell script is kept only as a reference for the business logic.
- The Lambda logs row counts and updated transaction UUIDs to CloudWatch Logs.
