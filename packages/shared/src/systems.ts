/**
 * External systems worth a box on an architecture diagram, recognised by the packages that
 * talk to them. Ordinary libraries (express, react, bcrypt, lodash…) are deliberately absent:
 * they are how a box is built, not what it talks to.
 */
export type SystemKind =
  | 'database'
  | 'cache'
  | 'search'
  | 'queue'
  | 'storage'
  | 'cloud'
  | 'payments'
  | 'email'
  | 'messaging'
  | 'ai'
  | 'auth'
  | 'monitoring'
  | 'api';

export interface SystemDef {
  name: string;
  kind: SystemKind;
  /** Exact package names; a trailing "/*" matches a scope or path prefix. */
  packages: string[];
  /** Words that identify the system in a hand-drawn box label. */
  aliases: string[];
  /**
   * Generic access layers (ORMs, HTTP clients). They join a concrete system of the same kind
   * when one is used, and only get their own box otherwise.
   */
  generic?: boolean;
}

export const SYSTEMS: readonly SystemDef[] = [
  {
    name: 'PostgreSQL',
    kind: 'database',
    packages: [
      'pg',
      'postgres',
      'pg-promise',
      '@neondatabase/serverless',
      '@vercel/postgres',
      'psycopg2',
      'psycopg',
      'asyncpg',
      'github.com/lib/pq',
      'github.com/jackc/pgx',
    ],
    aliases: ['postgres', 'postgresql', 'pg'],
  },
  {
    name: 'MySQL',
    kind: 'database',
    packages: ['mysql', 'mysql2', 'pymysql', 'MySQLdb', 'github.com/go-sql-driver/mysql'],
    aliases: ['mysql', 'mariadb'],
  },
  {
    name: 'SQLite',
    kind: 'database',
    packages: [
      'sqlite3',
      'better-sqlite3',
      'sqlite',
      '@libsql/client',
      'github.com/mattn/go-sqlite3',
    ],
    aliases: ['sqlite', 'libsql', 'turso'],
  },
  {
    name: 'MongoDB',
    kind: 'database',
    packages: ['mongodb', 'mongoose', 'pymongo', 'motor', 'go.mongodb.org/mongo-driver'],
    aliases: ['mongo', 'mongodb'],
  },
  {
    name: 'DynamoDB',
    kind: 'database',
    packages: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', 'dynamoose'],
    aliases: ['dynamo', 'dynamodb'],
  },
  {
    name: 'Database',
    kind: 'database',
    packages: [
      '@prisma/client',
      'prisma',
      'sequelize',
      'typeorm',
      'drizzle-orm',
      'knex',
      'kysely',
      '@mikro-orm/*',
      'objection',
      'sqlalchemy',
      'peewee',
      'tortoise',
      'gorm.io/gorm',
    ],
    aliases: ['database', 'db'],
    generic: true,
  },
  {
    name: 'Redis',
    kind: 'cache',
    packages: [
      'redis',
      'ioredis',
      '@upstash/redis',
      'aioredis',
      'github.com/redis/go-redis',
      'github.com/go-redis/redis',
    ],
    aliases: ['redis', 'cache'],
  },
  {
    name: 'Memcached',
    kind: 'cache',
    packages: ['memcached', 'memjs', 'pymemcache'],
    aliases: ['memcache', 'memcached'],
  },
  {
    name: 'Elasticsearch',
    kind: 'search',
    packages: ['@elastic/elasticsearch', 'elasticsearch', '@opensearch-project/opensearch'],
    aliases: ['elastic', 'elasticsearch', 'opensearch'],
  },
  {
    name: 'Algolia',
    kind: 'search',
    packages: ['algoliasearch'],
    aliases: ['algolia'],
  },
  {
    name: 'Kafka',
    kind: 'queue',
    packages: ['kafkajs', 'kafka-python', 'confluent_kafka', 'github.com/segmentio/kafka-go'],
    aliases: ['kafka'],
  },
  {
    name: 'RabbitMQ',
    kind: 'queue',
    packages: ['amqplib', 'amqp-connection-manager', 'pika', 'aio_pika'],
    aliases: ['rabbit', 'rabbitmq', 'amqp'],
  },
  {
    name: 'Job queue',
    kind: 'queue',
    packages: ['bullmq', 'bull', 'bee-queue', 'celery', 'rq', 'agenda'],
    aliases: ['queue', 'job queue'],
  },
  {
    name: 'AWS',
    kind: 'cloud',
    packages: ['aws-sdk', '@aws-sdk/*', 'boto3', 'botocore', 'github.com/aws/aws-sdk-go-v2'],
    aliases: ['aws', 's3', 'sqs', 'sns', 'lambda'],
  },
  {
    name: 'Google Cloud',
    kind: 'cloud',
    packages: ['@google-cloud/*', 'google'],
    aliases: ['gcp', 'google cloud', 'gcs'],
  },
  {
    name: 'Azure',
    kind: 'cloud',
    packages: ['@azure/*', 'azure'],
    aliases: ['azure'],
  },
  {
    name: 'Firebase',
    kind: 'cloud',
    packages: ['firebase', 'firebase-admin', 'firebase_admin'],
    aliases: ['firebase', 'firestore'],
  },
  {
    name: 'Supabase',
    kind: 'cloud',
    packages: ['@supabase/supabase-js', 'supabase'],
    aliases: ['supabase'],
  },
  {
    name: 'Cloudinary',
    kind: 'storage',
    packages: ['cloudinary'],
    aliases: ['cloudinary'],
  },
  {
    name: 'Stripe',
    kind: 'payments',
    packages: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js'],
    aliases: ['stripe'],
  },
  {
    name: 'PayPal',
    kind: 'payments',
    packages: ['@paypal/*', 'paypalrestsdk', 'paypal-rest-sdk'],
    aliases: ['paypal'],
  },
  {
    name: 'Adyen',
    kind: 'payments',
    packages: ['@adyen/api-library', '@adyen/adyen-web', 'Adyen'],
    aliases: ['adyen'],
  },
  {
    name: 'Email',
    kind: 'email',
    packages: [
      'nodemailer',
      '@sendgrid/mail',
      'sendgrid',
      'resend',
      'postmark',
      'mailgun.js',
      'mailgun-js',
      '@aws-sdk/client-ses',
    ],
    aliases: ['email', 'mail', 'smtp', 'sendgrid', 'mailgun', 'resend', 'postmark'],
  },
  {
    name: 'Twilio',
    kind: 'messaging',
    packages: ['twilio'],
    aliases: ['twilio', 'sms'],
  },
  {
    name: 'Slack',
    kind: 'messaging',
    packages: ['@slack/web-api', '@slack/bolt', 'slack_sdk', 'slack-bolt'],
    aliases: ['slack'],
  },
  {
    name: 'OpenAI',
    kind: 'ai',
    packages: ['openai', '@ai-sdk/openai'],
    aliases: ['openai', 'gpt', 'chatgpt'],
  },
  {
    name: 'Anthropic',
    kind: 'ai',
    packages: ['@anthropic-ai/sdk', 'anthropic', '@ai-sdk/anthropic'],
    aliases: ['anthropic', 'claude'],
  },
  {
    name: 'Auth0',
    kind: 'auth',
    packages: ['auth0', '@auth0/*', 'auth0-python'],
    aliases: ['auth0'],
  },
  {
    name: 'Clerk',
    kind: 'auth',
    packages: ['@clerk/*'],
    aliases: ['clerk'],
  },
  {
    name: 'OAuth provider',
    kind: 'auth',
    packages: [
      'passport-google-oauth20',
      'passport-github2',
      'passport-github',
      'passport-facebook',
      'passport-oauth2',
      'next-auth',
      '@auth/core',
      'authlib',
      'golang.org/x/oauth2',
    ],
    aliases: ['oauth', 'sso', 'github oauth', 'google oauth', 'identity provider'],
  },
  {
    name: 'Sentry',
    kind: 'monitoring',
    packages: ['@sentry/*', 'sentry_sdk', 'sentry-sdk'],
    aliases: ['sentry'],
  },
  {
    name: 'Datadog',
    kind: 'monitoring',
    packages: ['dd-trace', 'datadog', 'ddtrace'],
    aliases: ['datadog'],
  },
  {
    name: 'External APIs',
    kind: 'api',
    packages: ['axios', 'node-fetch', 'got', 'ky', 'undici', 'requests', 'httpx', 'aiohttp'],
    aliases: ['third-party api', 'external api', 'http api'],
    generic: true,
  },
];

function matches(pattern: string, pkg: string): boolean {
  return pattern.endsWith('/*') ? pkg.startsWith(pattern.slice(0, -1)) : pkg === pattern;
}

/** The system a package talks to, if it is one worth a box. */
export function systemOf(pkg: string): SystemDef | undefined {
  // Specific matches first: "@aws-sdk/client-dynamodb" is DynamoDB before it is AWS.
  return (
    SYSTEMS.find((s) => s.packages.some((p) => !p.endsWith('/*') && matches(p, pkg))) ??
    SYSTEMS.find((s) => s.packages.some((p) => matches(p, pkg)))
  );
}

/** The system a hand-drawn box's label names ("PostgreSQL (users)", "Redis cache"), if any. */
export function systemNamedIn(label: string): SystemDef | undefined {
  const text = ` ${label.toLowerCase().replace(/[^a-z0-9.]+/g, ' ')} `;
  return SYSTEMS.find((s) => s.aliases.some((a) => text.includes(` ${a} `)));
}
