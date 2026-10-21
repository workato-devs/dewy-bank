import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DewyBankStack } from '../lib/dewybank-stack';

function synth(workshopId = 'test01') {
  const app = new cdk.App();
  const stack = new DewyBankStack(app, `DewyBank-${workshopId}`, {
    workshopId,
    approvedSenderEmails: ['ops@example.com'],
    env: { account: '111111111111', region: 'us-west-2' },
  });
  return Template.fromStack(stack);
}

test('creates five per-workshop-prefixed DynamoDB tables (PAY_PER_REQUEST)', () => {
  const t = synth();
  t.resourceCountIs('AWS::DynamoDB::Table', 5);
  for (const name of ['Accounts', 'Customers', 'Transactions', 'Statements', 'GenieClients']) {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: `dewybank-test01-${name}`,
      BillingMode: 'PAY_PER_REQUEST',
    });
  }
});

test('tables use DESTROY removal policy (demo)', () => {
  const t = synth();
  t.allResources('AWS::DynamoDB::Table', Match.objectLike({ DeletionPolicy: 'Delete' }));
});

test('creates a Cognito user pool, SPA client (no secret) and facilitators group', () => {
  const t = synth();
  t.resourceCountIs('AWS::Cognito::UserPool', 1);
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    GenerateSecret: false,
  });
  t.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
    GroupName: 'facilitators',
  });
});

test('wires the post-confirmation Lambda trigger', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    LambdaConfig: Match.objectLike({ PostConfirmation: Match.anyValue() }),
  });
});

test('creates the named business Lambda handlers', () => {
  const t = synth();
  // Phase 1 adds framework Lambdas (custom-resource provider, s3 deployment,
  // key-gen), so an exact count is brittle. Assert the business handlers by name.
  for (const fn of [
    'dewybank-test01-customer-api-handler',
    'dewybank-test01-support-api-handler',
    'dewybank-test01-chat-handler',
    'dewybank-test01-cognito-post-confirmation',
    'dewybank-test01-provisioning',
    'dewybank-test01-lifecycle',
  ]) {
    t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: fn });
  }
});

test('creates an SES email identity for approved senders', () => {
  const t = synth();
  t.hasResourceProperties('AWS::SES::EmailIdentity', {
    EmailIdentity: 'ops@example.com',
  });
});

test('creates an EventBridge rule for the lifecycle schedule', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(1 hour)',
  });
});

// --- Phase 1 -------------------------------------------------------------

test('Accounts table has the owner-index GSI (customerId)', () => {
  const t = synth();
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'dewybank-test01-Accounts',
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({
        IndexName: 'owner-index',
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: 'customerId', KeyType: 'HASH' }),
        ]),
      }),
    ]),
  });
});

test('Customers table has the email-index GSI (C-P1)', () => {
  const t = synth();
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'dewybank-test01-Customers',
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({
        IndexName: 'email-index',
        KeySchema: Match.arrayWith([Match.objectLike({ AttributeName: 'email', KeyType: 'HASH' })]),
      }),
    ]),
  });
});

test('creates two HTTP APIs (customer + support)', () => {
  const t = synth();
  t.resourceCountIs('AWS::ApiGatewayV2::Api', 2);
  t.hasResourceProperties('AWS::ApiGatewayV2::Api', { Name: 'dewybank-test01-customer-api' });
  t.hasResourceProperties('AWS::ApiGatewayV2::Api', { Name: 'dewybank-test01-support-api' });
});

test('every route the stations, connectors and bank app call is wired', () => {
  const t = synth();
  for (const routeKey of [
    'POST /transfers',
    'POST /payments',
    'GET /accounts/{id}/transactions',
    'POST /admin/reseed',
    'PUT /me/genie-clients',
    'GET /me/genie-clients',
    'POST /chat',
    'GET /chat/events',
    'GET /support/whoami',
    'GET /support/customers/accounts',
    'POST /support/adjustments',
  ]) {
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: routeKey });
  }
});

test('the customer API allows PUT in CORS (P8)', () => {
  const t = synth();
  t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    Name: 'dewybank-test01-customer-api',
    CorsConfiguration: Match.objectLike({ AllowMethods: Match.arrayWith(['PUT']) }),
  });
});

test('Customer API has a Cognito JWT authorizer; Support API has none', () => {
  const t = synth();
  // Exactly one JWT authorizer, and it belongs to the customer API.
  t.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    AuthorizerType: 'JWT',
  });
});

test('Support API key is minted via a custom resource (never in template/outputs)', () => {
  const t = synth();
  // The key-gen Lambda + provider exist; the key VALUE is not an output.
  const outputs = t.findOutputs('*');
  const serialized = JSON.stringify(outputs);
  expect(serialized).not.toMatch(/dwk_/); // no key material in outputs
  t.hasOutput('SupportApiKeyParamName', {
    Value: '/dewybank/test01/support-api-key',
  });
});

test('exposes the outputs that unblock the connectors + the SPA', () => {
  const t = synth();
  t.hasOutput('SupportApiUrl', {});
  t.hasOutput('CustomerApiUrl', {});
  t.hasOutput('SpaUrl', {});
  const outputs = Object.keys(t.findOutputs('*'));
  for (const gone of ['AdminApiUrl', 'AdminApiKeyParamName', 'AdminPrincipalHeaderName']) {
    expect(outputs).not.toContain(gone);
  }
});

test('the post-confirmation Lambda may write seed transactions', () => {
  const t = synth();
  const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  // The trigger's role policy references the Transactions table.
  expect(policies).toMatch(/PostConfirmationFn[^"]*ServiceRoleDefaultPolicy/);
  const pc = Object.entries(t.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('PostConfirmationFn'))!;
  expect(JSON.stringify(pc[1])).toMatch(/TransactionsTable/);
});

test('creates a private S3 bucket + CloudFront distribution with SPA fallback', () => {
  const t = synth();
  t.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
  });
  t.resourceCountIs('AWS::CloudFront::Distribution', 1);
  t.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultRootObject: 'index.html',
      CustomErrorResponses: Match.arrayWith([
        Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
      ]),
    }),
  });
});
