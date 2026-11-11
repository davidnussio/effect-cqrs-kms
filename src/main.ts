/**
 * Tries the Google Cloud KMS master key of effect-cqrs.
 *
 *   node src/main.ts register <id> <name> <email> <country>
 *   node src/main.ts show <id>
 *   node src/main.ts forget <id>
 *   node src/main.ts demo
 *
 * Events and subject keys are kept in `data.sqlite`, so each command is a new
 * process that has to ask Cloud KMS to unwrap the subject's key. With
 * MASTER_KEY=local it uses a random key in memory, to try it without Google.
 */
import { NodeRuntime } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Config, Effect, Layer } from "effect"
import { AggregateService, PersonalData, SqliteEventStore } from "effect-cqrs"
import { SqlClient } from "effect/sql"
import { Customer } from "./domain.ts"
import { layerGoogleKms } from "./kms.ts"

// ---------------------------------------------------------------------------
// Master key: Cloud KMS, or a local one with MASTER_KEY=local.

const calls = { wrap: 0, unwrap: 0 }

/** Counts the calls to the master key, which Cloud KMS bills one by one. */
const Counted = Layer.effect(
  PersonalData.MasterKey,
  Effect.gen(function*() {
    const key = yield* PersonalData.MasterKey
    return PersonalData.MasterKey.of({
      keyId: key.keyId,
      wrap: (dataKey, context) => Effect.tap(key.wrap(dataKey, context), () => Effect.sync(() => calls.wrap++)),
      unwrap: (wrapped, context) => Effect.tap(key.unwrap(wrapped, context), () => Effect.sync(() => calls.unwrap++))
    })
  })
)

const MasterKey = Counted.pipe(Layer.provide(Layer.unwrap(Effect.gen(function*() {
  const mode = yield* Config.String("MASTER_KEY").pipe(Config.withDefault("kms"))
  if (mode === "local") {
    yield* Effect.logWarning("MASTER_KEY=local: a random key in memory, which no other process can read")
    return PersonalData.layerMasterKeyEphemeral
  }
  const keyName = yield* Config.String("PERSONAL_DATA_KMS_KEY")
  return layerGoogleKms(keyName)
}))))

// ---------------------------------------------------------------------------
// Storage: events and subject keys in the same SQLite file, which is enough for a test.

const Sqlite = SqliteClient.layer({ filename: "data.sqlite" })

const Storage = Layer.mergeAll(
  SqliteEventStore.layer(),
  PersonalData.layerSql().pipe(Layer.provide(MasterKey))
).pipe(Layer.provideMerge(Sqlite))

// ---------------------------------------------------------------------------
// What the commands print.

/** What the store really holds: the payload with its personal fields encrypted, and the wrapped key. */
const dump = Effect.fnUntraced(function*(id: string) {
  const sql = yield* SqlClient.SqlClient
  const events = yield* sql<{ readonly version: number; readonly type: string; readonly payload: string }>`
    SELECT version, type, payload FROM cqrs_events
    WHERE aggregate_name = 'customer' AND aggregate_id = ${id} ORDER BY version`
  const keys = yield* sql<{
    readonly key_id: string | null
    readonly master_key_id: string | null
    readonly wrapped_length: number | null
    readonly forgotten_at: number | null
  }>`
    SELECT key_id, master_key_id, length(wrapped) AS wrapped_length, forgotten_at
    FROM cqrs_personal_data_keys WHERE subject = ${id}`
  console.log("\nIn the database:")
  for (const event of events) {
    console.log(`  event v${event.version} ${event.type}: ${event.payload}`)
  }
  for (const key of keys) {
    console.log(
      key.forgotten_at !== null
        ? `  key of ${id}: destroyed at ${new Date(key.forgotten_at).toISOString()}`
        : `  key of ${id}: ${key.key_id}, wrapped by ${key.master_key_id} (${key.wrapped_length} base64 characters)`
    )
  }
  if (keys.length === 0) console.log(`  no key for ${id}`)
})

const show = Effect.fnUntraced(function*(id: string) {
  const customers = yield* AggregateService.make(Customer)
  const state = yield* customers.readModel(id)
  console.log(`\nState of ${id}, as the aggregate reads it:`, state)
  yield* dump(id)
})

const register = Effect.fnUntraced(function*(id: string, name: string, email: string, country: string) {
  const customers = yield* AggregateService.make(Customer)
  const result = yield* customers.commands.register(id, { name, email, country })
  console.log(`Registered ${id}, version ${result.version}`)
  yield* dump(id)
})

const forget = Effect.fnUntraced(function*(id: string) {
  yield* PersonalData.forget(id)
  console.log(`Forgot ${id}`)
  yield* show(id)
})

// ---------------------------------------------------------------------------

const usage = `Usage:
  node src/main.ts register <id> <name> <email> <country>
  node src/main.ts show <id>
  node src/main.ts forget <id>
  node src/main.ts demo`

const [command, ...args] = process.argv.slice(2)

const run = Effect.gen(function*() {
  switch (command) {
    case "register": {
      const [id, name, email, country] = args
      if (id === undefined || name === undefined || email === undefined || country === undefined) {
        return console.log(usage)
      }
      return yield* register(id, name, email, country)
    }
    case "show":
    case "forget": {
      const [id] = args
      if (id === undefined) return console.log(usage)
      return yield* command === "show" ? show(id) : forget(id)
    }
    case "demo": {
      // Everything in one process: the subject's key is in memory after the first command.
      const id = `demo-${Date.now()}`
      yield* register(id, "Ada Lovelace", "ada@example.com", "GB")
      yield* show(id)
      return yield* forget(id)
    }
    default:
      return console.log(usage)
  }
}).pipe(
  Effect.ensuring(Effect.sync(() => console.log(`\nMaster key calls: wrap ${calls.wrap}, unwrap ${calls.unwrap}`))),
  Effect.provide(Storage)
)

NodeRuntime.runMain(run)
