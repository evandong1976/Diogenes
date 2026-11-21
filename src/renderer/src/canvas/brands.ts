// Brand icons for the tech a component is built on (MongoDB, Stripe, Redis…), from simple-icons:
// official SVG paths and brand colors, bundled so they work offline and under the app's CSP.
import {
  siAnthropic,
  siApollographql,
  siAuth0,
  siAxios,
  siBun,
  siClerk,
  siCloudflare,
  siDeno,
  siDiscord,
  siDocker,
  siDrizzle,
  siElasticsearch,
  siElectron,
  siExpress,
  siFastify,
  siFirebase,
  siGithub,
  siGooglecloud,
  siGooglegemini,
  siGraphql,
  siHuggingface,
  siJsonwebtokens,
  siKubernetes,
  siLangchain,
  siLinear,
  siMinio,
  siMistralai,
  siMongodb,
  siMysql,
  siNeon,
  siNestjs,
  siNextdotjs,
  siNginx,
  siNodedotjs,
  siNotion,
  siOkta,
  siPassport,
  siPlanetscale,
  siPosthog,
  siPrisma,
  siPostgresql,
  siPusher,
  siRabbitmq,
  siReact,
  siRedis,
  siReplicate,
  siResend,
  siSentry,
  siSocketdotio,
  siSqlite,
  siStripe,
  siSupabase,
  siSvelte,
  siTemporal,
  siTrpc,
  siUpstash,
  siVercel,
  siVuedotjs,
  siApachekafka,
  siSequelize,
  siTypeorm,
  type SimpleIcon
} from 'simple-icons'
import type { DiagramNode } from './diagrams'

// Checked in order against the node's name, detail and ID; the first match wins. More specific
// products (Supabase, Neon, Prisma) come before the engines they sit on.
const RULES: [RegExp, SimpleIcon][] = [
  [/supabase/, siSupabase],
  [/neon(database)?\b/, siNeon],
  [/planetscale/, siPlanetscale],
  [/upstash/, siUpstash],
  [/prisma/, siPrisma],
  [/drizzle/, siDrizzle],
  [/sequelize/, siSequelize],
  [/typeorm/, siTypeorm],
  [/mongo/, siMongodb],
  [/postgres|\bpg\b|psql|kysely|knex/, siPostgresql],
  [/mysql|mariadb/, siMysql],
  [/sqlite/, siSqlite],
  [/redis|valkey/, siRedis],
  [/elasticsearch|@elastic\//, siElasticsearch],
  [/firebase|firestore/, siFirebase],
  [/kafka/, siApachekafka],
  [/rabbit|amqp/, siRabbitmq],
  [/socket\.io/, siSocketdotio],
  [/pusher/, siPusher],
  [/temporalio/, siTemporal],
  [/minio/, siMinio],
  [/stripe/, siStripe],
  [/anthropic|claude/, siAnthropic],
  [/gemini|@google\/genai|generative-ai/, siGooglegemini],
  [/google-cloud|gcp|pubsub/, siGooglecloud],
  [/mistral/, siMistralai],
  [/huggingface/, siHuggingface],
  [/package:replicate\b/, siReplicate],
  [/langchain/, siLangchain],
  [/github|octokit/, siGithub],
  [/discord/, siDiscord],
  [/resend/, siResend],
  [/sentry/, siSentry],
  [/posthog/, siPosthog],
  [/vercel/, siVercel],
  [/cloudflare|wrangler/, siCloudflare],
  [/@linear\/|linear\.app/, siLinear],
  [/notion/, siNotion],
  [/clerk/, siClerk],
  [/auth0/, siAuth0],
  [/okta/, siOkta],
  [/passport/, siPassport],
  [/jsonwebtoken|\bjwt\b|\bjose\b/, siJsonwebtokens],
  [/apollo/, siApollographql],
  [/graphql/, siGraphql],
  [/trpc/, siTrpc],
  [/axios/, siAxios],
  [/electron|\bipc\b/, siElectron],
  [/next\.?js|package:next\b|\bnext\//, siNextdotjs],
  [/nestjs/, siNestjs],
  [/fastify/, siFastify],
  [/\bexpress\b/, siExpress],
  [/svelte/, siSvelte],
  [/\bvue\b/, siVuedotjs],
  [/\breact\b/, siReact],
  [/docker/, siDocker],
  [/kubernetes|\bk8s\b|helm/, siKubernetes],
  [/nginx/, siNginx],
  [/\bbun\b/, siBun],
  [/\bdeno\b/, siDeno],
  [/\bnode\b|node\.js/, siNodedotjs]
]

export interface Brand {
  title: string
  path: string
  hex: string
  /** Glyph color that reads on the brand color. */
  ink: string
}

const inkFor = (hex: string): string => {
  const n = parseInt(hex, 16)
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.6 ? '#0B0D09' : '#FFFFFF'
}

export function brandFor(node: Pick<DiagramNode, 'id' | 'label' | 'detail'>): Brand | null {
  const text = `${node.label} ${node.detail ?? ''} ${node.id}`.toLowerCase()
  const icon = RULES.find(([re]) => re.test(text))?.[1]
  if (!icon) return null
  // Near-black brands (Vercel, GitHub, Next) vanish on the dark canvas: lift them to cream.
  const hex = parseInt(icon.hex, 16) < 0x333333 ? 'ECE8DC' : icon.hex
  return { title: icon.title, path: icon.path, hex: `#${hex}`, ink: inkFor(hex) }
}

/** Node silhouette on the canvas, so a database reads as a database before you read its name. */
export type Shape =
  'store' | 'queue' | 'endpoint' | 'view' | 'service' | 'trigger' | 'states' | 'box'

export function shapeFor(node: DiagramNode, kind: string): Shape {
  const t = `${node.type ?? ''} ${node.kind}`.toLowerCase()
  if (/queue|topic|messaging/.test(t)) return 'queue'
  if (kind === 'resource' || /database|store|cache|bucket/.test(t)) return 'store'
  if (kind === 'operation') return 'endpoint'
  if (kind === 'view') return 'view'
  if (kind === 'workload') return 'service'
  if (kind === 'trigger') return 'trigger'
  if (kind === 'stateMachine') return 'states'
  return 'box'
}

/** HTTP method in an endpoint's name or address, for the method badge. */
export const methodOf = (node: DiagramNode): string | undefined =>
  `${node.label} ${node.detail ?? ''}`.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/)?.[1]
