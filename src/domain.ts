/**
 * A customer whose name and email are personal data: they are stored encrypted
 * with a key of the customer, and read as their replacement once forgotten.
 */
import { Effect, Schema } from "effect"
import { Aggregate, PersonalData } from "effect-cqrs"

export class AlreadyRegistered extends Schema.TaggedError<AlreadyRegistered>()("AlreadyRegistered", {
  customerId: Schema.String
}) {}

export const CustomerEvent = Schema.TaggedUnion({
  Registered: {
    name: PersonalData.field(Schema.String, { redacted: "[forgotten]" }),
    email: PersonalData.field(Schema.String, { redacted: "forgotten@example.invalid" }),
    country: Schema.String
  }
})

export type CustomerState =
  | { readonly status: "new" }
  | { readonly status: "registered"; readonly name: string; readonly email: string; readonly country: string }

export const Customer = Aggregate.make<CustomerState>()({
  name: "customer",
  events: CustomerEvent,
  initial: { status: "new" },
  projection: {
    Registered: (_, { country, email, name }) => ({ status: "registered", name, email, country })
  }
}).command("register", {
  payload: Schema.Struct({ name: Schema.NonEmptyString, email: Schema.String, country: Schema.String }),
  handler: (state, payload, { aggregateId }) =>
    state.status === "new"
      ? Effect.succeed(CustomerEvent.cases.Registered.make(payload))
      : Effect.fail(new AlreadyRegistered({ customerId: aggregateId }))
})
