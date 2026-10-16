/**
 * Operator CLI: map an external OIDC identity to an existing DisFAP user.
 *
 *   DATABASE_URL=… node dist/cli/provision-identity.js \
 *     --issuer https://login.example.com/ \
 *     --subject 00u1a2b3c4 \
 *     --user usr_abc123 \
 *     [--email alice@example.com] \
 *     [--reassign]
 *
 * This is intentionally a local, DB-direct administrative tool — there is NO
 * unauthenticated HTTP endpoint for provisioning. It:
 *   - requires the internal user to already exist (no auto-provisioning);
 *   - is idempotent (re-running the same mapping is a no-op);
 *   - refuses to repoint an existing (issuer, subject) to another user unless
 *     `--reassign` is passed deliberately;
 *   - prints only the action and the non-secret identifiers — never tokens,
 *     secrets, or credentials.
 *
 * Exit codes: 0 success, 1 provisioning error, 2 usage error.
 */

import { PrismaClient } from '@prisma/client';

import { provisionIdentity } from '../auth/identity-provisioning.js';
import { PrismaIdentityProvisioningStore } from '../db/prisma-repos.js';

interface Args {
  issuer: string | undefined;
  subject: string | undefined;
  user: string | undefined;
  email: string | undefined;
  reassign: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { issuer: undefined, subject: undefined, user: undefined, email: undefined, reassign: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    switch (token) {
      case '--issuer':
        args.issuer = argv[++i];
        break;
      case '--subject':
        args.subject = argv[++i];
        break;
      case '--user':
        args.user = argv[++i];
        break;
      case '--email':
        args.email = argv[++i];
        break;
      case '--reassign':
        args.reassign = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: provision-identity --issuer <url> --subject <sub> --user <userId> [--email <email>] [--reassign]',
      '',
      '  --issuer    Exact OIDC issuer (absolute http(s) URL, must match the token `iss`).',
      '  --subject   Exact token subject (`sub`) issued by that issuer.',
      '  --user      Existing internal DisFAP user id to map the identity to.',
      '  --email     Optional informational snapshot (never used as a key).',
      '  --reassign  Allow repointing an existing (issuer, subject) to another user.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    printUsage();
    return 2;
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  if (!args.issuer || !args.subject || !args.user) {
    process.stderr.write('error: --issuer, --subject and --user are all required\n');
    printUsage();
    return 2;
  }

  if (!process.env['DATABASE_URL']) {
    process.stderr.write('error: DATABASE_URL is not set\n');
    return 2;
  }

  const prisma = new PrismaClient();
  try {
    const store = new PrismaIdentityProvisioningStore(prisma);
    const action = await provisionIdentity(store, {
      issuer: args.issuer,
      subject: args.subject,
      userId: args.user,
      ...(args.email !== undefined ? { email: args.email } : {}),
      ...(args.reassign ? { reassign: true } : {}),
    });
    // Non-secret identifiers only.
    process.stdout.write(`${action}: issuer=${args.issuer} subject=${args.subject} user=${args.user}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
