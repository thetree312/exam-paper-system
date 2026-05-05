import { Schema } from "effect"
import z from "zod"
import { zod } from "@/util/effect-zod"

export function namedSchemaError<Tag extends string, Fields extends Schema.Struct.Fields>(tag: Tag, fields: Fields) {
  const dataSchema = Schema.Struct(fields)
  const wire = z
    .object({
      name: z.literal(tag),
      data: zod(dataSchema),
    })
    .meta({ ref: tag })

  const effectSchema = Schema.Struct({
    name: Schema.Literal(tag),
    data: dataSchema,
  }).annotate({ identifier: tag })

  type Data = Schema.Schema.Type<typeof dataSchema>

  class NamedSchemaError extends Error {
    static readonly Schema = wire
    static readonly EffectSchema = effectSchema
    static readonly tag = tag
    public static isInstance(input: unknown): input is NamedSchemaError {
      return typeof input === "object" && input !== null && "name" in input && (input as { name: unknown }).name === tag
    }

    public override readonly name: Tag = tag
    public readonly data: Data

    constructor(data: Data, options?: ErrorOptions) {
      super(tag, options)
      this.data = data
    }

    toObject(): { name: Tag; data: Data } {
      return { name: tag, data: this.data }
    }
  }

  Object.defineProperty(NamedSchemaError, "name", { value: tag })

  return NamedSchemaError
}
