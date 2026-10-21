/**
 * Dewy Bank — Admin API key generator (CloudFormation custom resource backend).
 *
 * Mints a strong random API key SERVER-SIDE at deploy and writes it into the
 * SSM SecureString named by env PARAM_NAME. The key value NEVER appears in the
 * CloudFormation template or stack outputs — only the parameter NAME is output
 * by the stack. On Create/Update the key is (re)generated only if the parameter
 * does not already exist, so repeat deploys keep the key stable; on Delete the
 * parameter is removed.
 *
 * This is a cfn-response custom resource handled by cr.Provider; it returns a
 * plain object and the provider framework handles the SUCCESS/FAILED callback.
 */
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import { randomBytes } from 'crypto';

const ssm = new SSMClient({});
const PARAM_NAME = process.env.PARAM_NAME!;

type CfnEvent = {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties?: Record<string, unknown>;
};

export const handler = async (event: CfnEvent): Promise<{ PhysicalResourceId: string }> => {
  console.log('admin-api-key-gen', event.RequestType, PARAM_NAME);

  if (event.RequestType === 'Delete') {
    try {
      await ssm.send(new DeleteParameterCommand({ Name: PARAM_NAME }));
    } catch (err: any) {
      if (err?.name !== 'ParameterNotFound') throw err;
    }
    return { PhysicalResourceId: PARAM_NAME };
  }

  // Create / Update: keep an existing key stable; mint one only if absent.
  let exists = false;
  try {
    await ssm.send(new GetParameterCommand({ Name: PARAM_NAME, WithDecryption: false }));
    exists = true;
  } catch (err: any) {
    if (err?.name !== 'ParameterNotFound') throw err;
  }

  if (!exists) {
    const key = `dwk_${randomBytes(32).toString('hex')}`;
    await ssm.send(
      new PutParameterCommand({
        Name: PARAM_NAME,
        Value: key,
        Type: 'SecureString',
        Overwrite: false,
        Description: 'Dewy Bank Admin API static key (x-api-key). Workato-facing.',
      }),
    );
    console.log('admin-api-key-gen: minted new key');
  } else {
    console.log('admin-api-key-gen: key already present, leaving stable');
  }

  return { PhysicalResourceId: PARAM_NAME };
};
