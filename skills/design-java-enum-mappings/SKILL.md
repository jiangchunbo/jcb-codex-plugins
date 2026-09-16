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
- Name enum constants with conventional uppercase English identifiers such as `LOCKED` or `PENDING_REVIEW`. Do not use Chinese text, localized labels, display copy, or other external prose as `Enum.name()`, even though Java permits Unicode identifiers.
- Give every enum constant a concise JavaDoc comment describing its business meaning.
- Read distinct values from each target database before a migration. An enum declaration is also a runtime data-validity constraint.

## Choose The Smallest Mapping

| Contract | Preferred declaration |
| --- | --- |
| Database and JSON values equal a conventional Java enum name | Plain enum constants |
| Persisted value differs from `name()` | Explicit typed field marked with `@EnumValue`; use `IEnum<T>` only when the surrounding project deliberately prefers the interface contract |
| Persisted or JSON enum value is Chinese text | English enum constant plus an explicit `value`; map the value at each required boundary |
| JSON value differs from `name()` | Explicit value plus `@JsonValue`; add an appropriate `@JsonCreator` for input |
| Only JSON differs and the enum is not persisted | Do not add `IEnum` or `@EnumValue`; model only the JSON mapping |
| Value set is open or externally owned | Keep a `String` or the protocol's native type |

Treat persistence and JSON as independent contracts. A database code may differ from `name()` while the JSON value still uses `name()`, or the reverse.

## Prefer Plain Name-Based Enums

When the stored and transferred value is already a conventional uppercase English enum name, declare only the constants:

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

Plain mapping is not appropriate merely because external Chinese text could legally be written as a Java identifier. Java constant naming remains an internal code contract; persisted or transferred Chinese enum values belong in an explicit `value` field.

## Model Chinese Values Explicitly

When a stable database or JSON contract uses Chinese text as the enum value, keep Java identifiers conventional and carry the external value in `value`:

```java
@RequiredArgsConstructor
public enum MaterialLockStatus {

    /** Data may still change */
    UNLOCKED("未锁定"),

    /** Data is stable and may be verified */
    LOCKED("已锁定");

    @EnumValue
    private final String value;

    @JsonValue
    public String getValue() {
        return value;
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static MaterialLockStatus fromValue(String value) {
        if (value == null) {
            return null;
        }
        for (MaterialLockStatus status : values()) {
            if (status.value.equals(value)) {
                return status;
            }
        }
        throw new IllegalArgumentException("Unknown material lock status: " + value);
    }
}
```

Use `value` for the actual persisted or transferred enum value, including Chinese protocol values. Use `code` when the external identity is specifically a machine-defined code. Reserve `label` for optional short descriptive display text; a label does not define enum identity and must not participate in persistence, serialization, parsing, or equality. Do not introduce a `value` when it only duplicates an English `name()`.

Persistence and JSON still require separate decisions. For MyBatis Plus, prefer its built-in enum mechanism and mark the persisted field with `@EnumValue`; this keeps the enum free from a framework interface contract. Use `IEnum<T>` only when the surrounding project deliberately standardizes on it. Do not add a custom `TypeHandler` only to repeat this conversion. Check the resolved framework version's unknown-value behavior separately; add custom handling only when the business contract must distinguish an unknown stored value from SQL `null` and no boundary validation can enforce that distinction.

Under MyBatis Plus configurations that use `CompositeEnumTypeHandler`, including MyBatis Plus 3.5.2 with `MybatisConfiguration`:

- An enum implementing `IEnum` or containing an `@EnumValue` field is handled by `MybatisEnumTypeHandler`.
- Any other enum is delegated to the configured default enum handler. The ordinary MyBatis `EnumTypeHandler` writes `name()` and reads with `Enum.valueOf`.

Jackson also serializes an ordinary enum as `name()` and deserializes an exact matching name by default. Verify project-level MyBatis and Jackson configuration before relying on these defaults; a custom default enum handler or enum serialization feature can change them.

## Use Explicit Values Only For Different Codes

For a persisted numeric or non-name code, keep the code typed and explicit:

```java
@RequiredArgsConstructor
public enum TocManagementAdminStatus {

    /** Administrator account is enabled */
    ENABLED(1),

    /** Administrator account is disabled */
    DISABLED(0);

    @EnumValue
    private final Integer value;

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

Use exactly one MyBatis Plus enum declaration strategy. Prefer `@EnumValue` for lower coupling. If an enum implements `IEnum`, its `getValue()` already declares the persisted value, so adding `@EnumValue` to the same enum is redundant.

Add `@JsonValue` only when the JSON contract must use the explicit code. If JSON should still expose the enum name, leave `@JsonValue` off even when persistence uses `@EnumValue`.

## Keep Input Conversion Boundaries Separate

- `@JsonCreator(mode = DELEGATING)` controls Jackson deserialization for JSON request bodies. Use it when the API needs explicit null, normalization, alias, or invalid-value behavior; do not add it only to duplicate Jackson's exact-name default.
- `@JsonValue` controls Jackson output and can also influence Jackson's value lookup. It overrides the ordinary name-based output.
- Spring MVC `@RequestParam` and `@PathVariable` enum conversion uses the conversion service, normally `StringToEnumConverterFactory` and `Enum.valueOf`, rather than Jackson. A `@JsonCreator` does not customize those parameters.
- Register an explicit Spring `Converter<String, E>` when query or path parameters intentionally accept aliases, custom codes, or case-insensitive values.

## Account For Unknown Database Values

- The ordinary MyBatis `EnumTypeHandler` fails when a non-null database string is not an enum name.
- In MyBatis Plus 3.5.x, `MybatisEnumTypeHandler` can return `null` when an explicit stored value matches no constant.
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
3. Choose plain name-based enums only when existing values are conventional uppercase English constant names; otherwise use an explicit `value` or `code`, and keep any descriptive `label` separate from identity.
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
- Reject localized or otherwise non-conventional enum constant names during review; verify external values remain unchanged through persistence and JSON round trips, and verify labels do not participate in enum identity.
