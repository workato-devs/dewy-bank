import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * GitHub Actions OIDC deploy role (CI/CD infrastructure).
 *
 * Deployed ONCE, independent of the per-workshop application stack. It creates a
 * least-privilege role that GitHub Actions assumes via OIDC — no long-lived AWS
 * keys ever live in the repo.
 *
 * The role itself has NO AWS service permissions. All it can do is assume the
 * CDK bootstrap roles (`cdk-<qualifier>-*`); CloudFormation then performs the
 * privileged work through the bootstrap's cfn-exec-role. This is the sanctioned
 * CDK-in-CI pattern and keeps the blast radius to "whatever CDK deploys".
 *
 * Trust is pinned to ONE repo and (by default) the `main` branch ref, plus the
 * PR `environment` subject so an Environment-gated deploy job is accepted. A
 * workflow running from any other repo/branch cannot assume this role.
 */
export interface GithubOidcStackProps extends cdk.StackProps {
  /** `owner/repo`, e.g. `workato-devs/dewy-bank-internal`. */
  readonly githubOwnerRepo: string;

  /**
   * ARN of the EXISTING GitHub OIDC provider in this account. We import it
   * rather than create it (the account already has one; two providers for the
   * same URL is an error).
   */
  readonly oidcProviderArn: string;

  /**
   * CDK bootstrap qualifier (the `hnb659fds` in `cdk-hnb659fds-*`). Default is
   * the standard qualifier `cdk bootstrap` uses unless `--qualifier` was passed.
   */
  readonly cdkQualifier?: string;

  /**
   * Extra `sub` claims the role will trust, beyond `main`. Use for a manual
   * `workflow_dispatch` from a branch, or a GitHub Environment subject.
   * Examples:
   *   `repo:owner/repo:ref:refs/heads/main`      (default, always added)
   *   `repo:owner/repo:environment:production`   (Environment-gated job)
   *   `repo:owner/repo:ref:refs/heads/*`         (any branch — looser)
   */
  readonly additionalTrustedSubjects?: string[];
}

export class GithubOidcStack extends cdk.Stack {
  public readonly deployRoleArn: string;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const qualifier = props.cdkQualifier ?? 'hnb659fds';
    const { account, region } = cdk.Stack.of(this);

    // The subjects (`sub` claim) GitHub's OIDC token will carry. main is always
    // trusted; callers add Environment / dispatch subjects as needed.
    const subjects = [
      `repo:${props.githubOwnerRepo}:ref:refs/heads/main`,
      ...(props.additionalTrustedSubjects ?? []),
    ];

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubProvider',
      props.oidcProviderArn,
    );

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'dewybank-github-deploy',
      description:
        'Assumed by GitHub Actions via OIDC to run `cdk deploy`. Can only assume the CDK bootstrap roles.',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': subjects,
        },
      }),
    });

    // The ONLY permission: assume the CDK bootstrap roles. CloudFormation (via
    // the cfn-exec-role) does the privileged work, so we never grant Lambda /
    // DynamoDB / IAM / etc. directly to the CI principal.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${account}:role/cdk-${qualifier}-deploy-role-${account}-${region}`,
          `arn:aws:iam::${account}:role/cdk-${qualifier}-file-publishing-role-${account}-${region}`,
          `arn:aws:iam::${account}:role/cdk-${qualifier}-image-publishing-role-${account}-${region}`,
          `arn:aws:iam::${account}:role/cdk-${qualifier}-lookup-role-${account}-${region}`,
        ],
      }),
    );

    this.deployRoleArn = deployRole.roleArn;

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Set this as the AWS_DEPLOY_ROLE_ARN repo variable / secret in GitHub Actions.',
    });
  }
}
