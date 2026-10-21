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

new DewyBankStack(app, `DewyBank-${workshopId}`, {
  workshopId,
  approvedSenderEmails,
  // Target account/region (plan: your account, us-west-2). CDK_DEFAULT_*
  // are populated from the active `--profile` at synth/deploy time; the literals
  // are the fallback so synth is deterministic without env plumbing.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000',
    region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
  },
  description: `Dewy Bank security-education workshop — Phase 0 foundations (workshop ${workshopId}).`,
});

// GitHub Actions OIDC deploy role (CI/CD infra). Deployed once, independent of
// the per-workshop app stack. Imports the account's EXISTING GitHub OIDC
// provider. Override repo/provider/subjects via context if they ever change:
//   -c githubOwnerRepo=owner/repo -c oidcProviderArn=arn:... \
//   -c extraTrustedSubjects=repo:owner/repo:environment:production
const githubOwnerRepo =
  (app.node.tryGetContext('githubOwnerRepo') as string | undefined) ??
  'workato-devs/dewy-bank-internal';
const oidcProviderArn =
  (app.node.tryGetContext('oidcProviderArn') as string | undefined) ??
  `arn:aws:iam::${process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000'}:oidc-provider/token.actions.githubusercontent.com`;
const extraTrustedSubjectsRaw = app.node.tryGetContext('extraTrustedSubjects') as
  | string
  | undefined;
const additionalTrustedSubjects = extraTrustedSubjectsRaw
  ? extraTrustedSubjectsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : // Default: also trust the `production` GitHub Environment subject, so an
    // Environment-gated deploy job (with a manual approval reviewer) is accepted.
    [`repo:${githubOwnerRepo}:environment:production`];

new GithubOidcStack(app, 'DewyBank-GithubOidc', {
  githubOwnerRepo,
  oidcProviderArn,
  additionalTrustedSubjects,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000',
    region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
  },
  description: 'Dewy Bank — GitHub Actions OIDC deploy role (CI/CD infra, deploy once).',
});

app.synth();
