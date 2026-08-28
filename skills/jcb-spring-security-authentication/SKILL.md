---
name: jcb-spring-security-authentication
description: Design, implement, refactor, and review Spring Security authentication systems in JCB Java Web style. Use when working on login flows, logout flows, security/authentication packages, AuthenticationFilter classes, AuthenticationConverter classes, AuthenticationToken request objects, AuthenticationProvider implementations and registration, AuthenticationSuccessHandler, AuthenticationFailureHandler, AuthenticationEntryPoint, AccessDeniedHandler, LogoutSuccessHandler, LogoutSuccessEvent listeners, UserAuthentication and UserPrincipal models, multi-principal user identity switching, PasswordEncoder registration, or Spring Security filter-chain authentication configuration.
---

# JCB Spring Security Authentication

Use this skill to build Spring Security authentication code that treats login as a clear pipeline:
request -> parameters -> unauthenticated token -> provider -> authenticated user authentication.

## Package Shape

Place authentication and authorization code under a top-level `security` package.

- Put stable business-facing security API types under `security.api`.
- Put login and authentication mechanisms under `security.authentication`.
- Split each login mechanism into its own package under `security.authentication`, using a short mechanism name such as `password`, `sms`, `teachingcode`, or `sso`.
- Put shared Spring Security handlers under `security.authentication.handler`.
- Put per-mechanism configuration in a single `*AuthenticationConfiguration` class inside that mechanism package.

## API Model

Use `UserAuthentication` for the final authenticated session object.

- Let `UserAuthentication` extend `AbstractAuthenticationToken`.
- Store a `UserPrincipal` in `UserAuthentication`.
- Return the business principal from `getPrincipal()`.
- Return `null` from `getCredentials()` for authenticated session objects.
- Add convenience methods such as `getUserId()`, `getMobile()`, `getPrincipalType()`, and typed principal accessors only when they reduce repeated casts in business code.

Use `UserPrincipal` for the stable business identity model.

- Keep base fields in `UserPrincipal`: user id, account identifier such as mobile or username, display nickname, principal type, and authorities.
- Represent multi-role or multi-identity systems with `UserPrincipal` subclasses.
- Add intermediate abstract principal classes when a subset of identities share fields, such as `BranchAdminUserPrincipal`.
- Keep `ROLE_*` authorities for access-control categories; keep detailed current-user identity in `UserPrincipal` subclasses.

## Authentication Mechanism Pattern

For each login mechanism, create the same set of concepts when applicable:

- `*AuthenticationFilter`
- `*AuthenticationConverter`
- `*AuthenticationParameters`
- `*AuthenticationToken`
- `*AuthenticationProvider`
- `*AuthenticationConfigurer`
- `*AuthenticationConfiguration`

Use the mechanism name as the package name. For account-password login, prefer `security.authentication.password`.

## Filter And Converter

Treat `*AuthenticationFilter` like a Spring Security controller for login.

- End filter classes with `AuthenticationFilter`.
- Extend `AbstractAuthenticationProcessingFilter`.
- Keep the filter thin: convert the request to an unauthenticated `Authentication`, then call `AuthenticationManager.authenticate`.
- Put JSON parsing and request normalization in a named converter.

Create a dedicated `*AuthenticationConverter`.

- Implement Spring Security `AuthenticationConverter`.
- Read request data into `*AuthenticationParameters`.
- Convert parameters into an unauthenticated `*AuthenticationToken`.
- For JSON request bodies, prefer:

```java
private static final GenericHttpMessageConverter<Object> HTTP_MESSAGE_CONVERTER =
        new MappingJackson2HttpMessageConverter();
```

- Normalize simple string inputs in the converter, such as converting `null` to `""` and applying `strip()`.
- Throw `AuthenticationServiceException` for request parsing failures.

## Token And Provider

Use `*AuthenticationToken` for the unauthenticated login request.

- End token classes with `AuthenticationToken`.
- Extend `AbstractAuthenticationToken`.
- Provide a static `unauthenticated(...)` factory for request tokens.
- Set authenticated state to false for request tokens.
- Return the account identifier from `getPrincipal()`.
- Return the login secret or credential material from `getCredentials()` only on the request token.

Use `*AuthenticationProvider` for the actual authentication logic.

- Implement `AuthenticationProvider`.
- In `authenticate(Authentication authentication)`, cast to the concrete token and delegate to an overloaded method.
- Cast directly; provider selection is a Spring Security contract guarded by `supports`.
- Validate required token fields.
- Query the minimal data needed to authenticate.
- Throw a project authentication exception for login failures.
- Construct a business `UserPrincipal` or one of its subclasses.
- Return a `UserAuthentication` that stores that principal.
- Implement `supports` with `ConcreteAuthenticationToken.class.isAssignableFrom(authentication)`.

## Configuration

Keep each mechanism's bean registration in its own `*AuthenticationConfiguration`.

- Register the mechanism's `*AuthenticationProvider` there.
- Register tightly coupled mechanism dependencies there when they are central to that mechanism.
- For password login, register the `PasswordEncoder` in `PasswordAuthenticationConfiguration`.
- Prefer `PasswordEncoderFactories.createDelegatingPasswordEncoder()` for default password encoding because it supports multiple `{id}` algorithms and defaults to bcrypt in Spring Security.

Add an `AuthenticationProviderConfiguration` when the system has multiple `AuthenticationProvider` beans.

- Put it under `security.authentication`.
- Discover all `AuthenticationProvider` beans from `ApplicationContext`.
- Sort them with `AnnotationAwareOrderComparator` before registration.
- Register each provider into `AuthenticationManagerBuilder`.
- In modern Spring Security, `InitializeAuthenticationProviderBeanManagerConfigurer` only auto-registers a provider when the global manager is not already configured and exactly one `AuthenticationProvider` bean exists; when multiple provider beans exist, it logs and registers none.
- Use `@Order` on provider beans only when provider order matters; otherwise let discovery plus sorting keep the registration deterministic.

Use `*AuthenticationConfigurer` to connect a login filter to `HttpSecurity`.

- End configurer classes with `AuthenticationConfigurer`.
- Write each mechanism configurer explicitly instead of introducing a shared generic configurer for a small amount of repeated setup.
- Set the `AuthenticationManager` from `http.getSharedObject(AuthenticationManager.class)`.
- Set `GenericAuthenticationSuccessHandler` and `GenericAuthenticationFailureHandler` directly with `new`.
- Pass needed dependencies such as `ObjectMapper` into the configurer constructor when the handler needs them.
- Set `SessionAuthenticationStrategy` and `AuthenticationDetailsSource` from shared objects when present.
- Set the filter `SecurityContextRepository` to `new HttpSessionSecurityContextRepository()` for Spring Session based projects.
- Set the filter `SecurityContextHolderStrategy` from the configurer.
- Add custom login filters before `AnonymousAuthenticationFilter`.

## Handlers

Use `security.authentication.handler` for common Spring Security handlers.

- Put common login success logic in `GenericAuthenticationSuccessHandler`.
- Put common login failure logic in `GenericAuthenticationFailureHandler`.
- Put common unauthenticated entry-point logic in `GenericAuthenticationEntryPoint`.
- Put common access-denied logic in `GenericAccessDeniedHandler`.
- Put common logout success logic in `GenericLogoutSuccessHandler`.
- Put mechanism-specific handlers inside the mechanism package.

## Exception Handling

Separate authentication exceptions from authorization exceptions.

- Use `AuthenticationEntryPoint` for unauthenticated or invalid-authentication requests.
- Return HTTP 401 from the entry point.
- Use `AccessDeniedHandler` for authenticated users who lack permission.
- Return HTTP 403 from the access-denied handler.
- For front-end separated systems, write JSON from both handlers using the project's normal response wrapper.
- If the request carried a session id or token but the server considers it invalid or expired, return a session-expired or session-invalid message.
- Treat "not logged in" and "session expired" as different UX states.

For session-based applications, a useful entry-point message rule is:

```java
if (request.getRequestedSessionId() != null && !request.isRequestedSessionIdValid()) {
    return "Session expired";
}
return "Please log in";
```

Adapt the message text to the project language.

## Logout

Configure logout for every login-capable system.

- Configure a logout URL in the main `SecurityFilterChain`.
- For front-end separated systems, use a `LogoutSuccessHandler` that returns JSON instead of redirecting.
- Keep `GenericLogoutSuccessHandler` focused on the HTTP logout response.
- Put post-logout business cleanup in an application listener for Spring Security `LogoutSuccessEvent`.
- In a logout event listener, inspect the event `Authentication`, narrow it to the project `UserAuthentication`, then perform identity-specific cleanup.

The reason is Spring Security's logout pipeline: `LogoutFilter` executes configured `LogoutHandler`s before calling the `LogoutSuccessHandler`, and `LogoutConfigurer#createLogoutFilter` adds `LogoutSuccessEventPublishingLogoutHandler` by default in modern Spring Security. This makes `LogoutSuccessEvent` the cleaner extension point for business side effects.

## Identity Switching

For systems where one account can act as multiple identities:

- List available identities as `UserPrincipal` instances.
- Compare identities by typed principal fields, not only by display name or role string.
- Persist the active identity separately if the system needs stable session restoration.
- On identity switch, create a new `UserAuthentication`, update `SecurityContext`, and save it through the configured `SecurityContextRepository`.

## References

Read `references/authentication-pattern-example.md` when concrete package and class examples are needed.
