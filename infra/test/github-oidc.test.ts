import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { GithubOidcStack } from '../lib/github-oidc-stack';

function trustedSubjects(props: Partial<ConstructorParameters<typeof GithubOidcStack>[2]> = {}) {
  const app = new cdk.App();
  const stack = new GithubOidcStack(app, 'Oidc', {
    githubOwnerRepo: 'example-org/dewy-bank',
    oidcProviderArn: 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com',
    env: { account: '111111111111', region: 'us-west-2' },
    ...props,
  });
  const role = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Role'))
    .find((r: any) => r.Properties.RoleName === 'dewybank-github-deploy') as any;
  const cond = role.Properties.AssumeRolePolicyDocument.Statement[0].Condition;
  const sub = (cond.StringLike ?? cond.StringEquals)['token.actions.githubusercontent.com:sub'];
  return ([] as string[]).concat(sub);
}

test('trusts main in the classic subject format by default', () => {
  expect(trustedSubjects()).toContain('repo:example-org/dewy-bank:ref:refs/heads/main');
});

test('uses the repo’s real subject prefix when given (immutable subjects)', () => {
  const prefix = 'repo:example-org@123/dewy-bank@456';
  const subjects = trustedSubjects({
    subjectPrefix: prefix,
    additionalTrustedSubjects: [`${prefix}:environment:production`],
  });
  expect(subjects).toEqual([`${prefix}:ref:refs/heads/main`, `${prefix}:environment:production`]);
});
