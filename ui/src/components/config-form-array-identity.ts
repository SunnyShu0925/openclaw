import { configValuesEqual } from "./config-form.constraints.ts";
import { jsonSchemaValuesEqual } from "@openclaw/normalization-core/json-value";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const arrayRowIdentities = new WeakMap<unknown[], readonly unknown[]>();

/** One rendered array owns row DOM identity, including unchanged cloned snapshots. */
export class ConfigFormArrayIdentity {
  private readonly identities = new WeakMap<unknown[], readonly symbol[]>();
  private previous: unknown[] = [];

  read(value: unknown[]): readonly symbol[] {
    const existing = this.identities.get(value);
    if (existing?.length === value.length) {
      this.previous = value;
      return existing;
    }
    const previousKeys = this.identities.get(this.previous) ?? [];
    // Reserve unchanged positions so a new equal value cannot steal a survivor's key.
    const remaining = new Set(
      this.previous.flatMap((entry, index) =>
        configValuesEqual(entry, value[index]) ? [] : [index],
      ),
    );
    const keys = value.map((entry, index) => {
      const match = configValuesEqual(entry, this.previous[index])
        ? index
        : [...remaining].find((candidate) => configValuesEqual(entry, this.previous[candidate]));
      if (match === undefined) {
        return Symbol("array-row");
      }
      remaining.delete(match);
      return previousKeys[match]!;
    });
    this.identities.set(value, keys);
    this.previous = value;
    return keys;
  }

  patch(
    value: unknown[],
    keys: readonly symbol[],
    onPatch: (value: unknown[]) => boolean | void,
  ): boolean {
    // Publish tokens before a synchronous render; rejected candidates must not
    // replace the original array's ownership, even when its values are equal.
    const previous = this.previous;
    this.identities.set(value, keys);
    const accepted = onPatch(value) !== false;
    if (!accepted) {
      this.identities.delete(value);
      this.previous = previous;
    }
    return accepted;
  }
}

export function preserveConfigArrayRowIdentities(previous: unknown, next: unknown): void {
  const pairs: Array<[unknown, unknown]> = [[previous, next]];
  const visited = new WeakSet<object>();
  for (const [source, target] of pairs) {
    if (!target || typeof target !== "object" || visited.has(target)) {
      continue;
    }
    visited.add(target);
    if (Array.isArray(source) && Array.isArray(target)) {
      const identities = arrayRowIdentities.get(source);
      // Refreshes replace objects, not logical rows. The canonical comparator
      // is asymmetric; correspondence needs both directions. Local edits
      // carry explicit survivor tokens instead.
      if (
        identities?.length !== source.length ||
        !jsonSchemaValuesEqual(source, target) ||
        !jsonSchemaValuesEqual(target, source)
      ) {
        continue;
      }
      preserveArrayRowIdentities(target, identities);
      target.forEach((value, index) => pairs.push([source[index], value]));
    } else if (isRecord(source) && isRecord(target)) {
      for (const key of Object.keys(target)) {
        if (Object.hasOwn(source, key)) {
          pairs.push([source[key], target[key]]);
        }
      }
    }
  }
}
