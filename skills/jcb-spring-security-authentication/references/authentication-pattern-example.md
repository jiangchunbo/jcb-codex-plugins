# Authentication Pattern Example

Use this reference as a concrete example of the JCB Spring Security authentication style.

## Package Layout

Example root:

```text
com.example.project.security
├── api
├── authentication
│   ├── handler
│   ├── password
│   ├── sms
│   ├── ssostudyspace
│   └── teachingcode
├── config
├── controller
├── service
└── session
```

`security.api` contains business-facing authentication and principal types:

- `UserAuthentication`
- `UserPrincipal`
- `UserPrincipalType`
- `SecurityRoles`
- `TeacherUserPrincipal`
- `StudentUserPrincipal`
- `BranchAdminUserPrincipal`
- `AreaAdminUserPrincipal`
- `SchoolAdminUserPrincipal`
- `GroupSchoolAdminUserPrincipal`

`BranchAdminUserPrincipal` is an intermediate abstract principal for identities that share `branchId` and `branchName`.

## Password Login Example

The password mechanism uses:

- `PasswordAuthenticationFilter`
- `PasswordAuthenticationConverter`
- `PasswordAuthenticationParameters`
- `PasswordAuthenticationToken`
- `PasswordAuthenticationProvider`
- `PasswordAuthenticationConfigurer`
- `PasswordAuthenticationConfiguration`

`PasswordAuthenticationFilter` should stay thin:

```java
public Authentication attemptAuthentication(HttpServletRequest request,
                                            HttpServletResponse response) throws AuthenticationException, IOException {
    Authentication authRequest = this.authenticationConverter.convert(request);
    return this.getAuthenticationManager().authenticate(authRequest);
}
```

`PasswordAuthenticationConverter` reads JSON into parameters and creates the unauthenticated token:

```java
PasswordAuthenticationParameters parameters = readParameters(request);
return PasswordAuthenticationToken.unauthenticated(
        prepare(parameters.getMobile()),
        prepare(parameters.getPassword())
);
```

`PasswordAuthenticationProvider` casts by contract and delegates:

```java
@Override
public Authentication authenticate(Authentication authentication) throws AuthenticationException {
    return authenticate((PasswordAuthenticationToken) authentication);
}
```

Then it validates fields, queries the user, verifies the password, resolves a `UserPrincipal`, and returns:

```java
return new UserAuthentication(userPrincipal, null);
```

## Configuration Example

`PasswordAuthenticationConfiguration` is the single registration entry for password authentication components:

```java
@Bean
public PasswordEncoder passwordEncoder() {
    return PasswordEncoderFactories.createDelegatingPasswordEncoder();
}

@Bean
public PasswordAuthenticationProvider passwordAuthenticationProvider(SysUserMapper sysUserMapper,
                                                                     UserPrincipalFallbackResolver resolver,
                                                                     PasswordEncoder passwordEncoder) {
    return new PasswordAuthenticationProvider(sysUserMapper, resolver, passwordEncoder);
}
```

When the system has more than one `AuthenticationProvider`, add a provider aggregation configuration:

```java
@Configuration(proxyBeanMethods = false)
public class AuthenticationProviderConfiguration {

    @Bean
    public AuthenticationProviderBeanManagerConfigurer authenticationProviderBeanManagerConfigurer(
            ApplicationContext context) {
        return new AuthenticationProviderBeanManagerConfigurer(context);
    }

    public static class AuthenticationProviderBeanManagerConfigurer
            extends GlobalAuthenticationConfigurerAdapter {

        private final ApplicationContext context;

        public AuthenticationProviderBeanManagerConfigurer(ApplicationContext context) {
            this.context = context;
        }

        @Override
        public void init(AuthenticationManagerBuilder auth) throws Exception {
            auth.apply(new AuthenticationProviderManagerConfigurer());
        }

        class AuthenticationProviderManagerConfigurer extends GlobalAuthenticationConfigurerAdapter {

            @Override
            public void configure(AuthenticationManagerBuilder auth) {
                Map<String, AuthenticationProvider> beans =
                        context.getBeansOfType(AuthenticationProvider.class, true, true);
                List<AuthenticationProvider> providers = new ArrayList<>(beans.values());
                AnnotationAwareOrderComparator.sort(providers);
                for (AuthenticationProvider provider : providers) {
                    auth.authenticationProvider(provider);
                }
            }
        }
    }
}
```

This avoids the default Spring Security behavior where multiple `AuthenticationProvider` beans are discovered but none are automatically registered by the default bean manager.

## Handler Example

Shared handlers live under `security.authentication.handler`:

- `GenericAuthenticationSuccessHandler`
- `GenericAuthenticationFailureHandler`
- `GenericAuthenticationEntryPoint`
- `GenericAccessDeniedHandler`
- `GenericLogoutSuccessHandler`

The success handler resolves the authenticated `UserPrincipal` from either `UserAuthentication` or `authentication.getPrincipal()`, then returns the current-user response model.

The authentication entry point returns 401. Distinguish "not logged in" from "session expired":

```java
private String resolveMessage(HttpServletRequest request) {
    if (request.getRequestedSessionId() != null && !request.isRequestedSessionIdValid()) {
        return "Session expired";
    }
    return "Please log in";
}
```

The access-denied handler returns 403 for authenticated users without permission.

## Logout Example

Configure logout in the main security filter chain:

```java
httpSecurity.logout(logout -> logout
        .logoutUrl("/logout")
        .logoutSuccessHandler(genericLogoutSuccessHandler)
);
```

For front-end separated systems, `GenericLogoutSuccessHandler` should only write the JSON response:

```java
public void onLogoutSuccess(HttpServletRequest request,
                            HttpServletResponse response,
                            Authentication authentication) throws IOException {
    response.setStatus(HttpStatus.OK.value());
    httpMessageConverter.write(
            Result.<Void>success(null),
            MediaType.APPLICATION_JSON,
            new ServletServerHttpResponse(response)
    );
}
```

Place business cleanup in a `LogoutSuccessEvent` listener:

```java
@Component
@RequiredArgsConstructor
public class StudentLogoutCleanupListener {

    private final StudentLogoutCleanupService studentLogoutCleanupService;

    @EventListener
    public void onLogoutSuccess(LogoutSuccessEvent event) {
        Authentication authentication = event.getAuthentication();
        if (authentication instanceof UserAuthentication userAuthentication) {
            StudentUserPrincipal principal = userAuthentication.getStudentPrincipal();
            if (principal != null) {
                studentLogoutCleanupService.cleanup(principal.getStudentId());
            }
        }
    }
}
```

Use the listener pattern for logout side effects because Spring Security publishes `LogoutSuccessEvent` from its logout handler chain before invoking the configured logout success response handler.

## Filter Chain Example

`SecurityConfiguration` attaches multiple authentication mechanisms to one filter chain:

```java
httpSecurity.with(new PasswordAuthenticationConfigurer<>(), Customizer.withDefaults());
httpSecurity.with(new TeachingCodeAuthenticationConfigurer<>(), Customizer.withDefaults());
httpSecurity.with(new SmsAuthenticationConfigurer<>(), Customizer.withDefaults());
httpSecurity.with(new SsoStudySpaceAuthenticationConfigurer<>(), Customizer.withDefaults());
```

Each mechanism configurer sets up its own filter directly:

```java
public class PasswordAuthenticationConfigurer<H extends HttpSecurityBuilder<H>>
        extends AbstractHttpConfigurer<PasswordAuthenticationConfigurer<H>, H> {

    private final PasswordAuthenticationFilter authenticationFilter =
            new PasswordAuthenticationFilter("/login-with-password");

    private final ObjectMapper objectMapper;

    public PasswordAuthenticationConfigurer(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void configure(H http) throws Exception {
        authenticationFilter.setAuthenticationManager(http.getSharedObject(AuthenticationManager.class));
        authenticationFilter.setAuthenticationSuccessHandler(new GenericAuthenticationSuccessHandler(objectMapper));
        authenticationFilter.setAuthenticationFailureHandler(new GenericAuthenticationFailureHandler(objectMapper));

        SessionAuthenticationStrategy sessionAuthenticationStrategy =
                http.getSharedObject(SessionAuthenticationStrategy.class);
        if (sessionAuthenticationStrategy != null) {
            authenticationFilter.setSessionAuthenticationStrategy(sessionAuthenticationStrategy);
        }

        AuthenticationDetailsSource<HttpServletRequest, ?> authenticationDetailsSource =
                http.getSharedObject(AuthenticationDetailsSource.class);
        if (authenticationDetailsSource != null) {
            authenticationFilter.setAuthenticationDetailsSource(authenticationDetailsSource);
        }

        authenticationFilter.setSecurityContextRepository(new HttpSessionSecurityContextRepository());
        authenticationFilter.setSecurityContextHolderStrategy(getSecurityContextHolderStrategy());
        http.addFilterBefore(postProcess(authenticationFilter), AnonymousAuthenticationFilter.class);
    }
}
```

Repeat this setup in each mechanism configurer. The duplication is small and keeps each authentication path obvious.
