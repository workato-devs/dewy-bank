#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { DewyBankStack } from '../lib/dewybank-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

// Per-workshop prefix (decision 6.2). Pass with:
//   npx cdk synth -c workshopId=demo01
// Falls back to "dev" so a bare `cdk synth` validates the model.
const workshopId = (app.node.tryGetContext('workshopId') as string | undefined) ?? 'dev';

// Approved SES senders (decision 6.5), comma-separated:
//   -c approvedSenders=ops@example.com,alerts@example.com
const approvedSendersRaw = app.node.tryGetContext('approvedSenders') as string | undefined;
const approvedSenderEmails = approvedSendersRaw
  ? approvedSendersRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

// Target account/region: whatever the active AWS profile resolves to
// (`--profile`, or the AWS_* environment). CDK fills CDK_DEFAULT_* from it.
// With no profile (e.g. CI's synth-only job), the stacks synth
// environment-agnostic, and a deploy fails for lack of credentials.
const env =
  process.env.CDK_DEFAULT_ACCOUNT && process.env.CDK_DEFAULT_REGION
    ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
    : undefined;

new DewyBankStack(app, `DewyBank-${workshopId}`, {
  workshopId,
  approvedSenderEmails,
  env,
  description: `Dewy Bank security-education workshop (workshop ${workshopId}).`,
});

// GitHub Actions OIDC deploy role (CI/CD infra). Deployed once per account,
// independent of the per-workshop app stack. Imports the account's EXISTING
// GitHub OIDC provider. Pass these for your repo:
//   -c githubOwnerRepo=owner/repo
//   -c githubSubjectPrefix=<the repo's sub-claim prefix>   (see below)
//   -c oidcProviderArn=arn:...                               (optional)
//   -c extraTrustedSubjects=<sub>,<sub>                      (optional, replaces the default)
//
// githubSubjectPrefix: GitHub prefixes every OIDC `sub` claim with either the
// classic `repo:owner/repo` or, when the repo uses immutable subjects,
// `repo:owner@<ownerId>/repo@<repoId>`. The role only trusts subjects that
// match exactly, so pass what this returns:
//   gh api repos/<owner>/<repo>/actions/oidc/customization/sub   (sub_claim_prefix)
// It defaults to the classic form.
const githubOwnerRepo =
  (app.node.tryGetContext('githubOwnerRepo') as string | undefined) ??
  'workato-devs/dewy-bank';
const subjectPrefix =
  (app.node.tryGetContext('githubSubjectPrefix') as string | undefined) ??
  `repo:${githubOwnerRepo}`;
const oidcProviderArn =
  (app.node.tryGetContext('oidcProviderArn') as string | undefined) ??
  `arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`;
const extraTrustedSubjectsRaw = app.node.tryGetContext('extraTrustedSubjects') as
  | string
  | undefined;
const additionalTrustedSubjects = extraTrustedSubjectsRaw
  ? extraTrustedSubjectsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : // Default: also trust the `production` GitHub Environment subject, so an
    // Environment-gated deploy job (with a manual approval reviewer) is accepted.
    [`${subjectPrefix}:environment:production`];

new GithubOidcStack(app, 'DewyBank-GithubOidc', {
  githubOwnerRepo,
  subjectPrefix,
  oidcProviderArn,
  additionalTrustedSubjects,
  env,
  description: 'Dewy Bank — GitHub Actions OIDC deploy role (CI/CD infra, deploy once).',
});

app.synth();
