# Dewy Bank — Security Posture

This document describes the security architecture of the Dewy Bank application: the controls in place, the trust boundaries between components, and the residual risks that have been consciously accepted.

---

## 1. Architecture Overview

Dewy Bank is a serverless web application deployed entirely on AWS. There are no long-running servers and no VPCs. The entry point for all web traffic is a CloudFront distribution, and all backend compute is Lambda.

```
Browser
  │
  ▼
CloudFront distribution          ← HTTPS entry point; enforces TLS, serves the SPA
  │
  ├── S3 bucket (private, OAC)   ← SPA static assets; no public bucket policy
  │
  └── [browser calls directly]
        │
        ├── API Gateway HTTP API  ← Customer API (JWT-authenticated)
        │     └── Lambda (customer-api-handler)
        │           └── DynamoDB (Accounts, Transactions, Payees, Customers, Statements)
        │
        ├── API Gateway HTTP API  ← Support API (static key-authenticated)
        │     └── Lambda (support-api-handler)
        │           └── DynamoDB (same tables, fictional customers only)
        │
        └── Lambda Function URL  ← Chat (AWS_IAM-authenticated, SigV4)
              └── Lambda (chat-bedrock-handler)
                    ├── AWS Bedrock (LLM inference)
                    └── Workato MCP servers (external tool providers)
```

Trust boundaries:

- The **public internet** reaches only CloudFront, the two API Gateway endpoints, and the Lambda Function URL. All three enforce authentication before any application code runs.
- **S3** is entirely private; CloudFront accesses it via Origin Access Control (OAC), not a public bucket policy.
- **DynamoDB** is not reachable from the internet. Only Lambda execution roles, each scoped to the minimum required table operations, have access.
- **Bedrock** is called from the chat Lambda using its execution role; no credentials flow to the browser.
- **Workato MCP servers** are external providers. The chat Lambda contacts them over HTTPS using bearer tokens stored in Lambda environment variables, never exposed client-side.

Each workshop deployment is namespaced by a `workshopId`. All resource names (DynamoDB tables, Lambda functions, Cognito pools) carry this prefix, so multiple deployments in the same AWS account are isolated from each other at the IAM and naming level.

---

## 2. Authentication and Authorization

### User Authentication

Users authenticate through an Amazon Cognito User Pool. Sign-in is email/password using SRP (Secure Remote Password) or user-password auth flows; the SPA client has no secret (public PKCE-equivalent client). On successful authentication, Cognito issues a set of JWTs: an ID token (claims about the user) and an access token.

Password policy requires at least 8 characters with lowercase letters and digits. Account recovery is email-only.

### JWT Validation

Every Customer API route is fronted by an API Gateway HTTP API with a Cognito JWT authorizer. The authorizer validates the ID token's signature against the Cognito User Pool's public JWKS endpoint, checks the `aud` claim matches the SPA client ID, and rejects expired tokens — all before the Lambda handler is invoked. The validated `sub` claim (the user's Cognito identity) is injected into the event as `requestContext.authorizer.jwt.claims.sub` and is the only identity the Lambda trusts. Caller-supplied identity values in the request body or path are never trusted for ownership decisions.

The chat Lambda adds a second layer of JWT validation in-process. Because the `Authorization` header carries the SigV4 signature, the Cognito ID token is forwarded in a custom `x-cognito-token` header. The Lambda verifies it with `aws-jwt-verify` before opening the SSE stream. A missing or invalid token returns HTTP 401 before any Bedrock call is made.

### Chat Function URL Protection — Two Layers

The chat endpoint uses a two-layer authentication model:

**Layer 1 — AWS IAM / SigV4.** The Lambda Function URL is configured with `AuthType.AWS_IAM`. The AWS runtime evaluates the SigV4 signature on every request before invoking the handler; unsigned or incorrectly signed requests are rejected with HTTP 403 at the infrastructure layer, before any Lambda compute runs or any cost is incurred.

**Layer 2 — Cognito Identity Pool.** To obtain valid SigV4 credentials, the browser exchanges the user's Cognito ID token for temporary STS credentials via a Cognito Identity Pool. The identity pool has `allowUnauthenticatedIdentities: false`, so only users who hold a valid Cognito session can receive credentials. The resulting STS credentials assume the `chat-caller` IAM role, which is scoped to `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the chat function ARN only.

The Lambda resource-based policy explicitly lists the `chat-caller` role and the `facilitators` role as the only allowed principals. Any other AWS principal — including other roles in the same account — is denied.

### Facilitator vs. Participant Authorization

Cognito users who are members of the `facilitators` group receive a different IAM role when they obtain identity pool credentials. The `facilitators` role extends the participant role with one additional permission: invoking the provisioning Lambda. Facilitators can also access the `/admin/*` Customer API routes; those routes check the `cognito:groups` claim from the validated JWT and return 403 to anyone not in the group.

Participant accounts have no IAM permissions beyond calling the chat function URL. They cannot invoke provisioning, access admin routes, or read any other customer's data.

---

## 3. Network and Transport Security

### HTTPS Everywhere

CloudFront is configured with `ViewerProtocolPolicy.REDIRECT_TO_HTTPS`. HTTP requests are redirected to HTTPS before any content is served. The API Gateway endpoints and Lambda Function URL are HTTPS-only by design (AWS enforces this; HTTP is not available).

### CORS Configuration

Both API Gateway endpoints allow `allowOrigins: ["*"]` at the CORS preflight level. This is appropriate because all actual authorization is performed server-side by the JWT authorizer and Lambda handlers; the CORS origin check would provide no meaningful security boundary in this configuration. The Lambda Function URL CORS configuration lists the specific headers required for SigV4 (`authorization`, `x-amz-security-token`, `x-amz-date`, `x-amz-content-sha256`, `x-cognito-token`, `content-type`) and only the `POST` method.

### Lambda Function URL Exposure

The chat Lambda Function URL is publicly reachable (it must be, for the browser to call it directly). Its protection relies entirely on `AuthType.AWS_IAM`: the AWS runtime validates every request's SigV4 signature against the resource-based policy before invoking the handler. There is no mechanism by which an anonymous caller can reach the Lambda's application code.

### No VPC

The Lambdas run in the default AWS-managed network and do not use a VPC. This is an accepted design choice for a serverless application of this scale. The compensating controls are IAM authentication at every Lambda entry point, execution roles scoped to the minimum required permissions, and the fact that DynamoDB, SSM, and Bedrock are all accessed via AWS service endpoints using the Lambda's execution role — not via network connectivity. There is no database port or private network endpoint to protect.

---

## 4. Data Protection

### What Is Stored

DynamoDB holds five per-workshop-prefixed tables:

- **Customers** — `customerId` (Cognito sub), email address, creation timestamp.
- **Accounts** — account ID, owning customer ID, account type, balance (in integer cents).
- **Transactions** — account ID, transaction ID, type, amount, counterparty, memo, channel, timestamp.
- **Statements** — account ID, statement ID, period, opening/closing balances.
- **Payees** — customer ID, payee email, timestamp.

No passwords, payment card numbers, government IDs, or sensitive PII beyond email address and bank account data are stored. Balances are fictional (seeded at workshop time).

### Data Scoping

Every Customer API route is scoped to the caller's `sub`. The `listOwnedAccounts` helper queries the Accounts table via the `owner-index` GSI keyed on `customerId = sub`; `getOwnedAccount` fetches by account ID and then checks `item.customerId === sub`. A caller cannot read or modify another customer's accounts by guessing an account ID, because the ownership check is server-side and uses the validated JWT claim, not any value from the request.

The Support API is scoped to `fictional: true` records. It can only read and adjust accounts whose `fictional` flag is set, regardless of what email or account ID the caller supplies.

### Encryption

Data in transit is protected by TLS (HTTPS) on all paths. Data at rest in DynamoDB and S3 uses AWS-managed server-side encryption (SSE-S3 for the bucket; AWS-owned keys for DynamoDB), which is the AWS default. The support API key is stored as an SSM SecureString and decrypted at Lambda cold start using the execution role; it is never present in CloudFormation outputs, stack templates, or environment variables in plaintext form.

### Memo Field Policy

The memo field is stored and returned exactly as submitted. The only validation applied is type (must be a string) and length (must be at most 280 Unicode code points; longer memos are rejected outright rather than silently truncated). No server-side sanitization, escaping, or filtering is applied to memo content. This is a deliberate design decision: the memo field is an audit record of what the sender wrote.

---

## 5. Input Validation and Injection Prevention

### DynamoDB Queries

All DynamoDB operations use the AWS SDK's document client with parameterized `ExpressionAttributeValues`. There is no string interpolation into query expressions. DynamoDB's query model does not support SQL-style injection; keys and values are typed and transmitted as separate parameters over the AWS SDK wire protocol.

### Memo Field

The `parseMemo` function in `infra/lambda/shared/memo.ts` validates that the memo is a string and counts code points (so emoji count once). It rejects memos over 280 characters with a 400 error; it never truncates. No content filtering is applied beyond this. Content-level defenses (XSS escaping, HTML sanitization) are the responsibility of the rendering layer, not the storage layer.

The SPA uses DOMPurify to sanitize all user-supplied content before inserting it into the DOM as HTML. Memo text displayed in the transaction history passes through DOMPurify before rendering.

### MCP Server URLs

MCP server URLs for the chat handler are resolved exclusively from Lambda environment variables (`MCP_URL_A1` through `MCP_URL_C2`), which are set at CDK deploy time. The handler does accept a `mcp_url` field from the request body for facilitator-configured overrides, but in normal operation all URLs originate from the Lambda's own environment. The chat handler never fetches URLs supplied by tool results or LLM output. This prevents server-side request forgery (SSRF) attacks where a manipulated tool response could redirect the Lambda to an attacker-controlled server.

### Support API Key Comparison

The support API handler compares the caller-supplied `x-api-key` header against the expected key using Node's `crypto.timingSafeEqual`. This prevents timing-based key enumeration attacks.

---

## 6. Abuse Prevention

### Signup Control

The Cognito User Pool has `selfSignUpEnabled: true` by default to allow participants to register themselves. Facilitators can set `AllowAdminCreateUserOnly` on the User Pool to restrict account creation to admin-initiated invitations only. This is a per-deployment configuration choice.

### Rate Limiting

There is no WAF or explicit rate limiting beyond AWS service quotas (API Gateway and Lambda concurrency limits, Bedrock per-account token budgets). This is accepted for the deployment scale. AWS service quotas provide a natural ceiling on runaway costs.

### Cost Protection

Bedrock inference is billed per token. The chat Lambda caps responses at 4,096 output tokens per request and limits conversation history to the last 80 messages. MCP server bearer tokens are issued per deployment and can be revoked independently of the application by rotating the Workato connection credentials.

### Workshop Isolation

Each deployment uses a `workshopId` prefix on all DynamoDB tables, Lambda functions, Cognito pools, and IAM role names. A participant in one workshop namespace has no access to tables or resources in another namespace, because the IAM policy for each role refers specifically to the ARNs within its own deployment.

### Facilitator-Only Admin Operations

The provisioning Lambda (reseed, setup, teardown) can only be invoked by the `facilitators` IAM role. Participants cannot invoke it directly. The `/admin/*` Customer API routes require the `facilitators` Cognito group claim; the Lambda handler enforces this check independently of the API Gateway authorizer, so a misconfigured authorizer alone would not expose admin functionality.

---

## 7. Known Accepted Risks

The following risks have been reviewed and consciously accepted for this deployment.

**No WAF.** An AWS WAF is not deployed in front of CloudFront or the API Gateway endpoints. For a controlled environment with a known participant population, the added cost and complexity is not justified. AWS service quotas and authentication requirements provide the primary abuse mitigations.

**Lambda Function URL publicly reachable.** The chat Lambda's HTTPS endpoint is publicly reachable on the internet. This is mitigated by `AuthType.AWS_IAM`: no unsigned request can invoke the handler. The endpoint address being discoverable does not represent a security risk because the IAM layer is enforced by AWS infrastructure before any compute runs.

**Memo content stored without server-side sanitization.** Memo text is stored exactly as submitted. Any display context that renders memo content must apply its own sanitization (the SPA does this via DOMPurify). APIs that return memo data to consumers other than the SPA should be aware that memo content has not been sanitized.

**No encryption-at-rest beyond AWS defaults.** DynamoDB and S3 use AWS-owned or SSE-S3 encryption. Customer-managed KMS keys are not used. For a workshop environment handling only fictional financial data, this is appropriate.

**Bedrock model responses are not filtered.** LLM output is streamed directly to the browser. No content moderation filter is applied to model responses. This is appropriate for a controlled environment where the participant population is known and the content domain is constrained.

**SES in sandbox mode.** The SES integration for lifecycle notifications remains in AWS sandbox mode. Email delivery is limited to verified recipient addresses; no production-access request has been submitted. This limits the reach of automated notifications but does not affect application security.
