import * as path from "path";
import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as ses from "aws-cdk-lib/aws-ses";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cr from "aws-cdk-lib/custom-resources";

export interface DewyBankStackProps extends cdk.StackProps {
  /**
   * Per-workshop prefix (decision 6.2). Table names become
   * `dewybank-<workshopId>-{Accounts,Customers,Transactions,Statements}`.
   * Isolation is per-workshop, not per-user: a workshop is one logical
   * namespace of prefixed tables in the shared account.
   */
  readonly workshopId: string;

  /**
   * Approved sender email identities for SES SANDBOX mode (decision 6.5).
   * These are the "from" addresses lifecycle/warning mail is sent as. SES stays
   * in sandbox — no production-access request. Recipients (facilitator emails)
   * are verified separately as facilitators join the admin group.
   */
  readonly approvedSenderEmails?: string[];

  /** MCP server URLs for each station (set at deploy time via CDK context). */
  readonly mcpUrls?: Partial<
    Record<"A1" | "A2" | "B1" | "B2" | "C1" | "C2", string>
  >;

  /** Optional global MCP bearer token (applies to all stations unless overridden per-station). */
  readonly mcpBearerToken?: string;
}

/**
 * Dewy Bank — Phase 0 foundations.
 *
 * Models (plan §4 Phase 0 exit criteria):
 *   - per-workshop-prefixed DynamoDB tables (PAY_PER_REQUEST, DESTROY)
 *   - Cognito user pool + SPA app client (no secret) + `facilitators` admin group
 *   - a post-confirmation Lambda trigger (stub)
 *   - SES sandbox verified-identity construct (approved senders)
 *   - Lambdas: customer-api, support-api, chat, post-confirmation, provisioning, lifecycle
 *   - IAM: facilitators group may invoke the provisioning Lambda; least-privilege per Lambda
 *   - EventBridge rule driving the lifecycle Lambda
 *
 * NOT in Phase 0 (Phase 1+): API Gateway routes, the SPA, S3/CloudFront, business logic.
 */
export class DewyBankStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DewyBankStackProps) {
    super(scope, id, props);

    const { workshopId } = props;
    const prefix = `dewybank-${workshopId}`;

    cdk.Tags.of(this).add("project", "dewy-bank");
    cdk.Tags.of(this).add("workshopId", workshopId);

    // ---------------------------------------------------------------------
    // DynamoDB — per-workshop-prefixed tables (decision 6.2).
    // Shared instance, isolation via name prefix. Demo: PAY_PER_REQUEST + DESTROY.
    // Partition/sort keys are placeholders for Phase 0; Phase 1 refines the schema
    // to support per-principal queries. GSIs are added in Phase 1 as access
    // patterns are nailed down.
    // ---------------------------------------------------------------------
    const tableDefaults = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    } as const;

    const customersTable = new dynamodb.Table(this, "CustomersTable", {
      tableName: `${prefix}-Customers`,
      // customerId (Cognito sub)
      partitionKey: { name: "customerId", type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });
    // C-P1: look up a customer by email (/payments, the Support API, reseed).
    customersTable.addGlobalSecondaryIndex({
      indexName: "email-index",
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const accountsTable = new dynamodb.Table(this, "AccountsTable", {
      tableName: `${prefix}-Accounts`,
      // accountId; owner-index GSI (added below) maps owner (customerId) -> accounts.
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });
    // Phase 1 access pattern: "list the caller's accounts" (Customer API
    // GET /accounts, Admin API secure/my-accounts) queries by owner (customerId).
    accountsTable.addGlobalSecondaryIndex({
      indexName: "owner-index",
      partitionKey: { name: "customerId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const transactionsTable = new dynamodb.Table(this, "TransactionsTable", {
      tableName: `${prefix}-Transactions`,
      // accountId (PK) + txnId (SK) so an account's transactions are a query.
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "txnId", type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });

    const statementsTable = new dynamodb.Table(this, "StatementsTable", {
      tableName: `${prefix}-Statements`,
      // accountId (PK) + statementId (SK)
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "statementId", type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });

    const tableEnv = {
      WORKSHOP_ID: workshopId,
      TABLE_PREFIX: prefix,
      CUSTOMERS_TABLE: customersTable.tableName,
      ACCOUNTS_TABLE: accountsTable.tableName,
      TRANSACTIONS_TABLE: transactionsTable.tableName,
      STATEMENTS_TABLE: statementsTable.tableName,
    };

    // ---------------------------------------------------------------------
    // Support API key (C-P3; replaces the Admin API key, P7). Generated AT
    // DEPLOY and stored as an SSM SecureString
    // `/dewybank/<workshopId>/support-api-key`. The "Dewy Bank Support API"
    // connector presents it in the `x-api-key` header (participants paste it as
    // a "support code"); the Support API Lambda reads it at cold start.
    //
    // A Lambda-backed custom resource mints the key SERVER-SIDE at deploy and
    // writes it straight into the SecureString, so the value NEVER appears in
    // the CFN template or stack outputs — only the param NAME is output.
    // ---------------------------------------------------------------------
    const supportApiKeyParamName = `/dewybank/${workshopId}/support-api-key`;
    const supportApiKeyParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter/dewybank/${workshopId}/support-api-key`;

    const apiKeyProviderFn = new NodejsFunction(this, "SupportApiKeyGenFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(2),
      functionName: `${prefix}-support-api-key-gen`,
      entry: path.join(
        __dirname,
        "..",
        "lambda",
        "support-api-key-gen",
        "index.ts",
      ),
      bundling: { minify: false, sourceMap: true },
      environment: { PARAM_NAME: supportApiKeyParamName },
    });
    apiKeyProviderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
        ],
        resources: [supportApiKeyParamArn],
      }),
    );
    const apiKeyProvider = new cr.Provider(this, "SupportApiKeyProvider", {
      onEventHandler: apiKeyProviderFn,
    });
    const apiKeyResource = new cdk.CustomResource(
      this,
      "SupportApiKeyResource",
      {
        serviceToken: apiKeyProvider.serviceToken,
        // Changing this forces a re-mint; keep stable so the key is durable.
        properties: { paramName: supportApiKeyParamName },
      },
    );

    // ---------------------------------------------------------------------
    // Lambda stubs. NodejsFunction bundles the TS handlers with esbuild at
    // synth time (no Docker). Each gets ONLY the env/permissions it needs
    // (least privilege — plan §3.1 / scope item 5).
    // ---------------------------------------------------------------------
    const lambdaRoot = path.join(__dirname, "..", "lambda");
    const commonFnProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(15),
      bundling: { minify: false, sourceMap: true },
    } as const;

    // Cognito post-confirmation trigger (seed/provision — Phase 1).
    const postConfirmationFn = new NodejsFunction(this, "PostConfirmationFn", {
      ...commonFnProps,
      functionName: `${prefix}-cognito-post-confirmation`,
      entry: path.join(lambdaRoot, "cognito-post-confirmation", "index.ts"),
      environment: tableEnv,
    });
    // Needs to write seeded customer, account and transaction records.
    customersTable.grantWriteData(postConfirmationFn);
    accountsTable.grantWriteData(postConfirmationFn);
    transactionsTable.grantWriteData(postConfirmationFn);

    // Customer API handler (Phase 1) — reads/writes scoped to the caller's sub.
    const customerApiFn = new NodejsFunction(this, "CustomerApiFn", {
      ...commonFnProps,
      functionName: `${prefix}-customer-api-handler`,
      entry: path.join(lambdaRoot, "customer-api-handler", "index.ts"),
      environment: tableEnv,
    });
    customersTable.grantReadData(customerApiFn);
    accountsTable.grantReadWriteData(customerApiFn);
    transactionsTable.grantReadWriteData(customerApiFn);
    statementsTable.grantReadData(customerApiFn);

    // Support API handler (C-P3) — the support-agent routes, reaching only the
    // fictional customers. Reads customers, adjusts balances, writes history.
    const supportApiFn = new NodejsFunction(this, "SupportApiFn", {
      ...commonFnProps,
      functionName: `${prefix}-support-api-handler`,
      entry: path.join(lambdaRoot, "support-api-handler", "index.ts"),
      environment: { ...tableEnv, API_KEY_PARAM: supportApiKeyParamName },
    });
    customersTable.grantReadData(supportApiFn);
    accountsTable.grantReadWriteData(supportApiFn);
    transactionsTable.grantReadWriteData(supportApiFn);
    // Read the SecureString key at cold start (decrypted at runtime, never in
    // the template). Depends on the key existing first.
    supportApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [supportApiKeyParamArn],
      }),
    );
    supportApiFn.node.addDependency(apiKeyResource);

    // Provisioning Lambda (facilitator-invoked setup/teardown/reseed).
    const provisioningFn = new NodejsFunction(this, "ProvisioningFn", {
      ...commonFnProps,
      functionName: `${prefix}-provisioning`,
      entry: path.join(lambdaRoot, "provisioning", "index.ts"),
      timeout: cdk.Duration.minutes(5),
      environment: tableEnv,
    });
    customersTable.grantReadWriteData(provisioningFn);
    accountsTable.grantReadWriteData(provisioningFn);
    transactionsTable.grantReadWriteData(provisioningFn);
    statementsTable.grantReadWriteData(provisioningFn);
    // P10: facilitators start a reset from the console (POST /admin/reseed),
    // which invokes provisioning asynchronously.
    provisioningFn.grantInvoke(customerApiFn);
    customerApiFn.addEnvironment(
      "PROVISIONING_FN",
      provisioningFn.functionName,
    );

    // C-P4: create the fictional customers at deploy, so Station C's support
    // tools have someone to reach before any reset runs.
    const fictionalSetup = new cr.AwsCustomResource(
      this,
      "FictionalCustomersSetup",
      {
        onCreate: {
          service: "Lambda",
          action: "invoke",
          parameters: {
            FunctionName: provisioningFn.functionName,
            Payload: JSON.stringify({ action: "setup" }),
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `${prefix}-fictional-customers`,
          ),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction"],
            resources: [provisioningFn.functionArn],
          }),
        ]),
      },
    );
    fictionalSetup.node.addDependency(
      customersTable,
      accountsTable,
      transactionsTable,
    );

    // Lifecycle / expiry Lambda (EventBridge-scheduled auto-teardown + SES warnings).
    const lifecycleFn = new NodejsFunction(this, "LifecycleFn", {
      ...commonFnProps,
      functionName: `${prefix}-lifecycle`,
      entry: path.join(lambdaRoot, "lifecycle", "index.ts"),
      timeout: cdk.Duration.minutes(5),
      environment: tableEnv,
    });
    // Reads workshop expiry records to decide teardowns.
    customersTable.grantReadData(lifecycleFn);
    accountsTable.grantReadWriteData(lifecycleFn);
    transactionsTable.grantReadWriteData(lifecycleFn);
    statementsTable.grantReadWriteData(lifecycleFn);
    // SES SANDBOX send permission, scoped to this account/region's identities.
    lifecycleFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
      }),
    );

    // ---------------------------------------------------------------------
    // Cognito — user pool + SPA app client (no secret) + `facilitators` group.
    // Post-confirmation trigger wired to the stub above.
    // ---------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // demo
      lambdaTriggers: { postConfirmation: postConfirmationFn },
    });

    // SPA public client — no secret, SRP + user-password auth for the browser.
    const userPoolClient = userPool.addClient("SpaClient", {
      userPoolClientName: `${prefix}-spa`,
      generateSecret: false,
      authFlows: { userSrp: true, userPassword: true },
      // OAuth flows/callback URLs are filled in Phase 1 with the SPA origin.
    });

    // Bedrock + MCP chat handler (Bedrock migration). Streams SSE via Lambda
    // Function URL; JWT validation is in-Lambda (Function URL has AuthType.NONE).
    const chatBedrockFn = new NodejsFunction(this, "ChatBedrockFn", {
      ...commonFnProps,
      functionName: `${prefix}-chat-bedrock`,
      entry: path.join(lambdaRoot, "chat-handler", "index.ts"),
      timeout: cdk.Duration.minutes(3),
      memorySize: 512,
      environment: {
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        BEDROCK_REGION: "us-west-2",
        BEDROCK_MODEL_ID: "us.moonshotai.kimi-k3",
        MCP_URL_A1: props.mcpUrls?.A1 ?? "",
        MCP_URL_A2: props.mcpUrls?.A2 ?? "",
        MCP_URL_B1: props.mcpUrls?.B1 ?? "",
        MCP_URL_B2: props.mcpUrls?.B2 ?? "",
        MCP_URL_C1: props.mcpUrls?.C1 ?? "",
        MCP_URL_C2: props.mcpUrls?.C2 ?? "",
        ...(props.mcpBearerToken
          ? { MCP_BEARER_TOKEN: props.mcpBearerToken }
          : {}),
      },
    });

    // bedrock:InvokeModel on the system-defined cross-region inference profile
    // (double colon — no account ID) and the underlying foundation model family.
    chatBedrockFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}::inference-profile/us.moonshotai.kimi-k3`,
          `arn:aws:bedrock:*::foundation-model/moonshotai.kimi-k3*`,
        ],
      }),
    );

    // Lambda Function URL — bypasses API GW 29s timeout, essential for
    // multi-tool-call Bedrock loops. RESPONSE_STREAM pushes SSE immediately.
    const chatFnUrl = chatBedrockFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ["*"],
        allowedHeaders: ["authorization", "content-type"],
        allowedMethods: [lambda.HttpMethod.POST],
      },
    });

    // Admin group (decision 6.2 / 6.5). Facilitators are members of this group.
    const facilitatorsGroup = new cognito.CfnUserPoolGroup(
      this,
      "FacilitatorsGroup",
      {
        userPoolId: userPool.userPoolId,
        groupName: "facilitators",
        description:
          "Admin group — may invoke provisioning Lambdas and receive SES lifecycle mail.",
      },
    );

    // IAM: `facilitators` group members may invoke the provisioning Lambda
    // (scope item 5). The group's IAM role carries exactly this permission.
    const facilitatorsRole = new iam.Role(this, "FacilitatorsRole", {
      roleName: `${prefix}-facilitators`,
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": userPool.userPoolId,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
      description:
        "Role assumed by Cognito `facilitators` group members; may invoke provisioning Lambda.",
    });
    provisioningFn.grantInvoke(facilitatorsRole);
    facilitatorsGroup.roleArn = facilitatorsRole.roleArn;

    // ---------------------------------------------------------------------
    // SES — SANDBOX verified sender identities (decision 6.5).
    // Approved senders are verified as email identities; SES stays in sandbox
    // (no production-access request). Recipient (facilitator) identities are
    // added as a side effect of joining the admin group — a Phase-1/4 mechanism,
    // documented as a TODO here. We only model the APPROVED SENDERS in Phase 0.
    //
    // Note: an email identity requires out-of-band click-through verification of
    // the address owner before SES will send AS it; CDK only registers it.
    // ---------------------------------------------------------------------
    const approvedSenders = props.approvedSenderEmails ?? [];
    for (const email of approvedSenders) {
      // Low-level CfnEmailIdentity avoids an extra module import; EmailIdentity
      // (aws-ses) could replace this in Phase 1 if richer config is needed.
      new ses.CfnEmailIdentity(this, `ApprovedSender-${sanitizeId(email)}`, {
        emailIdentity: email,
      });
    }
    // TODO(decision 6.5 — Phase 1/4): "facilitator joins admin group -> add their
    // email as an SES verified identity". Candidate mechanism: a custom resource or
    // a group-membership-driven Lambda that calls ses:CreateEmailIdentity for the
    // new member's email, keeping SES in sandbox while permitting mail to them.

    // ---------------------------------------------------------------------
    // EventBridge — scheduled lifecycle check (decision 6.5).
    // Runs the lifecycle Lambda hourly to auto-teardown TTL'd workshops and send
    // SES warnings for long-lived resources.
    // ---------------------------------------------------------------------
    new events.Rule(this, "LifecycleSchedule", {
      ruleName: `${prefix}-lifecycle-schedule`,
      description:
        "Hourly workshop expiry check: auto-teardown TTL'd workshops + SES warnings.",
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(lifecycleFn)],
    });

    // ---------------------------------------------------------------------
    // API Gateway — HTTP APIs (Phase 1).
    //
    // Customer API: Cognito JWT authorizer (pool + SPA client). Every route is
    // protected; the handler scopes all data access to the validated `sub`.
    // CORS is open for the SPA. Every route is listed by hand (no {proxy+}).
    // Support API: SEPARATE HTTP API, NO Cognito — a static x-api-key checked in
    // the Lambda (C-P3). Called server-side by the connector, so no CORS.
    // ---------------------------------------------------------------------
    const corsPreflight = {
      allowHeaders: ["authorization", "content-type"],
      allowMethods: [
        apigwv2.CorsHttpMethod.GET,
        apigwv2.CorsHttpMethod.POST,
        apigwv2.CorsHttpMethod.OPTIONS,
      ],
      allowOrigins: ["*"],
    };

    // --- Customer API -----------------------------------------------------
    const customerIntegration = new HttpLambdaIntegration(
      "CustomerIntegration",
      customerApiFn,
    );
    const jwtAuthorizer = new HttpJwtAuthorizer(
      "CustomerJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
    const customerApi = new apigwv2.HttpApi(this, "CustomerApi", {
      apiName: `${prefix}-customer-api`,
      corsPreflight,
      defaultAuthorizer: jwtAuthorizer,
    });
    const customerRoutes: Array<[apigwv2.HttpMethod, string]> = [
      [apigwv2.HttpMethod.GET, "/me"],
      [apigwv2.HttpMethod.GET, "/accounts"],
      [apigwv2.HttpMethod.GET, "/accounts/{id}"],
      [apigwv2.HttpMethod.GET, "/accounts/{id}/transactions"],
      [apigwv2.HttpMethod.POST, "/transfers"],
      [apigwv2.HttpMethod.POST, "/payments"],
      [apigwv2.HttpMethod.GET, "/statements/{id}"],
      // Facilitator-gated admin console routes (same JWT auth; the handler
      // enforces `facilitators` group membership). No static key in the browser.
      [apigwv2.HttpMethod.GET, "/admin/overview"],
      [apigwv2.HttpMethod.GET, "/admin/accounts"],
      [apigwv2.HttpMethod.GET, "/admin/accounts/{id}/transactions"],
      [apigwv2.HttpMethod.POST, "/admin/adjust-balance"],
      [apigwv2.HttpMethod.POST, "/admin/set-balance"],
      [apigwv2.HttpMethod.POST, "/admin/transfer"],
      [apigwv2.HttpMethod.POST, "/admin/reseed"],
    ];
    for (const [method, routePath] of customerRoutes) {
      customerApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: customerIntegration,
      });
    }

    // --- Support API (static x-api-key; NO Cognito authorizer) ------------
    const supportIntegration = new HttpLambdaIntegration(
      "SupportIntegration",
      supportApiFn,
    );
    const supportApi = new apigwv2.HttpApi(this, "SupportApi", {
      apiName: `${prefix}-support-api`,
      // No defaultAuthorizer: the Lambda enforces the x-api-key itself.
    });
    const supportRoutes: Array<[apigwv2.HttpMethod, string]> = [
      [apigwv2.HttpMethod.GET, "/support/whoami"],
      [apigwv2.HttpMethod.GET, "/support/customers/accounts"],
      [apigwv2.HttpMethod.POST, "/support/adjustments"],
    ];
    for (const [method, routePath] of supportRoutes) {
      supportApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: supportIntegration,
      });
    }

    const customerApiUrl = customerApi.apiEndpoint; // https://<id>.execute-api.<region>.amazonaws.com
    const supportApiUrl = supportApi.apiEndpoint;

    // ---------------------------------------------------------------------
    // SPA — S3 (private, OAC) + CloudFront (plan §3.1 / Phase 1).
    // SPA routing: 403/404 -> index.html (200). The SPA reads runtime config
    // (Customer API URL, Cognito ids, region) from a generated `config.js`
    // deployed alongside the static assets, so no rebuild is needed per env.
    // The same values, plus the Support API URL, are published as `config.json`
    // for the Workato connectors, which fetch it server-side (P9). Nothing in
    // it is secret.
    // ---------------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, "SpaBucket", {
      bucketName: `${prefix}-spa-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true, // demo
    });

    const distribution = new cloudfront.Distribution(this, "SpaDistribution", {
      comment: `${prefix} SPA`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      // SPA fallback: deep links / unknown paths serve index.html.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
      ],
    });

    const spaConfig = {
      region: this.region,
      userPoolId: userPool.userPoolId,
      userPoolClientId: userPoolClient.userPoolClientId,
      customerApiUrl,
      supportApiUrl,
      workshopId,
      chatFunctionUrl: chatFnUrl.url,
    };

    new s3deploy.BucketDeployment(this, "SpaDeployment", {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "..", "web")),
        // Runtime config consumed by the SPA (window.DEWY_CONFIG).
        s3deploy.Source.data(
          "config.js",
          `window.DEWY_CONFIG = ${JSON.stringify(spaConfig)};`,
        ),
        // Runtime config consumed by the Workato connectors (P9).
        s3deploy.Source.jsonData("config.json", spaConfig),
      ],
    });

    const spaUrl = `https://${distribution.distributionDomainName}`;

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, "WorkshopId", { value: workshopId });
    new cdk.CfnOutput(this, "TablePrefix", { value: prefix });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "FacilitatorsGroupName", { value: "facilitators" });
    new cdk.CfnOutput(this, "FacilitatorsRoleArn", {
      value: facilitatorsRole.roleArn,
    });
    // These unblock the Workato connectors + the SPA.
    new cdk.CfnOutput(this, "CustomerApiUrl", { value: customerApiUrl });
    new cdk.CfnOutput(this, "SupportApiUrl", { value: supportApiUrl });
    new cdk.CfnOutput(this, "SupportApiKeyParamName", {
      value: supportApiKeyParamName,
    });
    new cdk.CfnOutput(this, "SpaUrl", { value: spaUrl });
    new cdk.CfnOutput(this, "SpaBucketName", { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, "CloudFrontDistributionId", {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, "ChatFunctionUrl", { value: chatFnUrl.url });
  }
}

/** Make an email safe to use as a CDK construct id. */
function sanitizeId(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, "-");
}
