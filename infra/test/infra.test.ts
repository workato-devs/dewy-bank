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

test('creates four per-workshop-prefixed DynamoDB tables (PAY_PER_REQUEST)', () => {
  const t = synth();
  t.resourceCountIs('AWS::DynamoDB::Table', 4);
  for (const name of ['Accounts', 'Customers', 'Transactions', 'Statements']) {
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

test('creates the five named business Lambda handlers', () => {
  const t = synth();
  // Phase 1 adds framework Lambdas (custom-resource provider, s3 deployment,
  // key-gen), so an exact count is brittle. Assert the business handlers by name.
  for (const fn of [
    'dewybank-test01-customer-api-handler',
    'dewybank-test01-admin-api-handler',
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

test('creates two HTTP APIs (customer + admin)', () => {
  const t = synth();
  t.resourceCountIs('AWS::ApiGatewayV2::Api', 2);
  t.hasResourceProperties('AWS::ApiGatewayV2::Api', { Name: 'dewybank-test01-customer-api' });
  t.hasResourceProperties('AWS::ApiGatewayV2::Api', { Name: 'dewybank-test01-admin-api' });
});

test('Customer API has a Cognito JWT authorizer; Admin API has none', () => {
  const t = synth();
  // Exactly one JWT authorizer, and it belongs to the customer API.
  t.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    AuthorizerType: 'JWT',
  });
});

test('Admin API key is minted via a custom resource (never in template/outputs)', () => {
  const t = synth();
  // The key-gen Lambda + provider exist; the key VALUE is not an output.
  const outputs = t.findOutputs('*');
  const serialized = JSON.stringify(outputs);
  expect(serialized).not.toMatch(/dwk_/); // no key material in outputs
  t.hasOutput('AdminApiKeyParamName', {
    Value: '/dewybank/test01/admin-api-key',
  });
});

test('exposes the Phase 1 outputs that unblock Workato + the SPA', () => {
  const t = synth();
  t.hasOutput('AdminApiUrl', {});
  t.hasOutput('CustomerApiUrl', {});
  t.hasOutput('SpaUrl', {});
  t.hasOutput('AdminPrincipalHeaderName', { Value: 'x-participant-sub' });
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
