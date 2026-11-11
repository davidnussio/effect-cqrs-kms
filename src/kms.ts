// The master key on Google Cloud KMS, as the personal data guide shows it.
import { KeyManagementServiceClient } from "@google-cloud/kms"
import { Effect, Layer } from "effect"
import { PersonalData } from "effect-cqrs"

/**
 * Wraps subject keys with a symmetric Cloud KMS key, named like
 * `projects/acme/locations/europe-west6/keyRings/app/cryptoKeys/personal-data`.
 */
export const layerGoogleKms = (keyName: string) =>
  Layer.effect(
    PersonalData.MasterKey,
    Effect.gen(function*() {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new KeyManagementServiceClient()),
        (client) => Effect.promise(() => client.close())
      )
      // Binds a wrapped key to its subject and id, so it can't be swapped for another.
      const context = (subject: string, keyId: string) => Buffer.from(JSON.stringify([subject, keyId]))
      const call = <A>(operation: "wrap" | "unwrap", subject: string, request: () => Promise<A>) =>
        Effect.tryPromise({
          try: request,
          catch: (cause) =>
            new PersonalData.PersonalDataError({ operation, subject, message: "Cloud KMS call failed", cause })
        })
      return PersonalData.MasterKey.of({
        keyId: keyName,
        wrap: (dataKey, { keyId, subject }) =>
          call("wrap", subject, () =>
            client.encrypt({
              name: keyName,
              plaintext: dataKey,
              additionalAuthenticatedData: context(subject, keyId)
            })).pipe(Effect.map(([{ ciphertext }]) => new Uint8Array(ciphertext as Uint8Array))),
        // Keys wrapped by an earlier crypto key name it as `masterKeyId`.
        unwrap: (wrapped, { keyId, masterKeyId, subject }) =>
          call("unwrap", subject, () =>
            client.decrypt({
              name: masterKeyId,
              ciphertext: wrapped,
              additionalAuthenticatedData: context(subject, keyId)
            })).pipe(Effect.map(([{ plaintext }]) => new Uint8Array(plaintext as Uint8Array)))
      })
    })
  )
