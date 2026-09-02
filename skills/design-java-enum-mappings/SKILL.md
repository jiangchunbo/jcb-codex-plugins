---
name: design-java-enum-mappings
description: Design, implement, refactor, or review JCB-style Java enum modeling across MyBatis, MyBatis Plus, Jackson, and Spring MVC. Use when fixed String or numeric fields may be closed value sets, when choosing plain name-based enums versus IEnum, @EnumValue, @JsonValue, or @JsonCreator, or when preserving database and HTTP contracts during enum migrations.
---

# Java Enum Mappings

## Purpose

Represent values owned by the application and proven to be finite with strong enum types. Prefer the smallest declaration that preserves the database and HTTP contracts, and avoid duplicating an enum's `name()` as a separate value.

## Classify The Value Set First

- Trace the producer, consumer, persistence column, existing data, and API contract before changing a `String` or number to an enum.
- Use an enum only when the application owns a closed set of values. Keep external protocol states, diagnostic codes, user input, and independently evolving upstream values open unless the boundary explicitly defines a stable closed set.
- Use the enum type consistently in entities, request/response models, and services when those layers represent the same domain value. Do not immediately convert it back to `String` in Service code.
- Give every enum constant a concise JavaDoc comment describing its business meaning.
- Read distinct values from each target database before a migration. An enum declaration is also a runtime data-validity constraint.

## Choose The Smallest Mapping

| Contract | Preferred declaration |
| --- | --- |
| Database and JSON values equal `Enum.name()` | Plain enum constants |
| Persisted value differs from `name()` | Explicit typed value with the project's MyBatis Plus enum convention, normally `IEnum<T>` and `@EnumValue` |
| JSON value differs from `name()` | Explicit value plus `@JsonValue`; add an appropriate `@JsonCreator` for input |
| Only JSON differs and the enum is not persisted | Do not add `IEnum` or `@EnumValue`; model only the JSON mapping |
| Value set is open or externally owned | Keep a `String` or the protocol's native type |

Treat persistence and JSON as independent contracts. A database code may differ from `name()` while the JSON value still uses `name()`, or the reverse.

## Prefer Plain Name-Based Enums

When the stored and transferred value is already a clear enum name, declare only the constants:

```java
public enum TocMembershipBenefitStatus {

    /** No membership entitlement */
    NONE,

    /** Membership entitlement is active */
    ACTIVE,

    /** Membership entitlement has expired */
    EXPIRED,

    /** Membership entitlement was superseded by an upgrade */
    UPGRADED
}
```

Do not add a duplicate `value` field, constructor, getter, `IEnum`, `@EnumValue`, or `@JsonValue` merely to repeat these names.

Under MyBatis Plus configurations that use `CompositeEnumTypeHandler`, including MyBatis Plus 3.5.2 with `MybatisConfiguration`:

- An enum implementing `IEnum` or containing an `@EnumValue` field is handled by `MybatisEnumTypeHandler`.
- Any other enum is delegated to the configured default enum handler. The ordinary MyBatis `EnumTypeHandler` writes `name()` and reads with `Enum.valueOf`.

Jackson also serializes an ordinary enum as `name()` and deserializes an exact matching name by default. Verify project-level MyBatis and Jackson configuration before relying on these defaults; a custom default enum handler or enum serialization feature can change them.

## Use Explicit Values Only For Different Codes

For a persisted numeric or non-name code, keep the code typed and explicit:

```java
@RequiredArgsConstructor
public enum TocManagementAdminStatus implements IEnum<Integer> {

    /** Administrator account is enabled */
    ENABLED(1),

    /** Administrator account is disabled */
    DISABLED(0);

    @EnumValue
    private final Integer value;

    @Override
    @JsonValue
    public Integer getValue() {
        return value;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static TocManagementAdminStatus fromValue(Integer value) {
        if (value == null) {
            return null;
        }
        for (TocManagementAdminStatus status : values()) {
            if (status.value.equals(value)) {
                return status;
            }
        }
        throw new IllegalArgumentException("Unknown administrator status: " + value);
    }
}
```

Return `null` only for null input and reject unknown non-null values. Do not silently accept unknown business states.

Add `@JsonValue` only when the JSON contract must use the explicit code. If JSON should still expose the enum name, leave `@JsonValue` off even when persistence uses `@EnumValue`.

## Keep Input Conversion Boundaries Separate

- `@JsonCreator(mode = DELEGATING)` controls Jackson deserialization for JSON request bodies. Use it when the API needs explicit null, normalization, alias, or invalid-value behavior; do not add it only to duplicate Jackson's exact-name default.
- `@JsonValue` controls Jackson output and can also influence Jackson's value lookup. It overrides the ordinary name-based output.
- Spring MVC `@RequestParam` and `@PathVariable` enum conversion uses the conversion service, normally `StringToEnumConverterFactory` and `Enum.valueOf`, rather than Jackson. A `@JsonCreator` does not customize those parameters.
- Register an explicit Spring `Converter<String, E>` when query or path parameters intentionally accept aliases, custom codes, or case-insensitive values.

## Account For Unknown Database Values

- The ordinary MyBatis `EnumTypeHandler` fails when a non-null database string is not an enum name.
- In MyBatis Plus 3.5.2, `MybatisEnumTypeHandler` can return `null` when an explicit stored value matches no constant.
- Test unknown values deliberately instead of assuming both handlers fail in the same way. Prefer visible failure for corrupted or unsupported business state unless the surrounding domain explicitly permits an unknown value.

## Recheck Framework Source When Versions Differ

- Inspect MyBatis Plus `MybatisConfiguration`, `CompositeEnumTypeHandler`, and `MybatisEnumTypeHandler.isMpEnums` to confirm handler selection.
- Inspect MyBatis `EnumTypeHandler` to confirm the configured plain-enum write and read behavior.
- Inspect Jackson `EnumSerializer`, enum deserializer construction, and project `ObjectMapper` features to confirm name, value, and creator precedence.
- Inspect Spring `StringToEnumConverterFactory` and registered converters to confirm non-body MVC parameter handling.
- Treat the resolved dependency source and application configuration as authoritative; do not generalize behavior observed in one framework version to every project.

## Refactoring Workflow

1. Inventory candidate fields and distinguish closed application values from open external values.
2. Record the current database values and every HTTP representation before editing declarations.
3. Choose plain name-based enums whenever the existing values already equal meaningful constant names.
4. Use explicit persistence or JSON mappings only for contracts that actually differ.
5. Update entity, DTO, VO, and Service types together while preserving field names and serialized values.
6. Remove redundant `getValue()` conversions after downstream types become enums.
7. Avoid DDL or data updates when existing column types and values already support the enum mapping.

## Verification Checklist

- Verify MyBatis parameter writes, result reads, SQL nulls, and unknown stored values for both plain and explicitly valued enums in the project's actual framework version.
- Verify Jackson serialization, deserialization, null input, and invalid input.
- Verify `@RequestParam` and `@PathVariable` separately from JSON request bodies when they accept enums.
- Read representative rows from the target environment before claiming compatibility; do not write business data as part of a read-only mapping check.
- Compile and test all affected modules, and confirm frontend comparisons still receive the original JSON values.
- Reinspect the diff for redundant value fields, missing constant comments, accidental contract changes, and unrelated edits.
