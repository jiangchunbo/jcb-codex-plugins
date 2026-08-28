---
name: design-java-mybatis-query-services
description: Design, implement, refactor, or review Java Spring backend query services that use MyBatis or MyBatis Plus. Use for pagination APIs, Service/DAO layering, Mapper XML SQL style, entity-first query design, VO/DTO/Result mapping, and comparisons of alternative query implementations.
---

# Java MyBatis Query Services

## Purpose

Apply a clear query-service style for Java Spring applications using MyBatis or MyBatis Plus: keep DAO queries entity-first and narrowly scoped, then assemble API views in the Service with named intermediate data.

## Core Principles

- Prefer returning domain entities or main-table entities from primary pagination queries.
- Keep Mapper methods single-table and responsibility-specific unless database-side filtering, sorting, aggregation, or pagination requires otherwise.
- Avoid shaping SQL around page display fields when Service-layer assembly is practical.
- Use mapper `Result` classes only for projections, statistics, aggregation, or query results that entities cannot reasonably represent.
- Never return interface VO types from Mapper methods; construct VO objects in Service code.
- For custom pagination Mapper methods, use `Page<?> page` as the pagination parameter and return a concrete `Page<T>` for the actual query result type.
- In Service code, pass `query.toMybatisPage()` directly into the Mapper method and capture the returned page as `pageResult`.
- After pagination, base `getRecords`, empty-page return, `convert`, and `PageResults.from` on `pageResult`.
- Use named local variables for query, mapping, and assembly steps. Do not compress multiple conceptual steps into dense chained calls.
- Inline small, single-use VO/DTO/Result field assignment at the call site. Extract `toXxx` methods only when conversion is complex, reused, or materially clarifies the main flow.

## Service Workflow

For pagination and list-style APIs:

1. Normalize query fields first, such as trimming keywords or applying field-level defaults.
2. Pass `query.toMybatisPage()` directly into the primary Mapper pagination method.
3. Capture the Mapper return value as `Page<T> pageResult`; MyBatis Plus fills and returns the input `IPage` instance.
4. If the page has no records, return immediately while preserving pagination metadata.
5. Extract batch keys from the main records, such as ids, user ids, or parent ids.
6. Query auxiliary data separately, such as review records, attachment counts, creator users, names, or statistics.
7. Convert auxiliary lists to maps keyed by the id used during assembly.
8. Build API VO records in Service code, using `page.convert` when it preserves pagination metadata cleanly.

Preferred shape:

```java
query.setKeyword(StringUtils.trimToNull(query.getKeyword()));

Page<Article> pageResult = articleMapper.selectPendingPage(query.toMybatisPage(), query);
List<Article> pageRecords = pageResult.getRecords();
if (pageRecords.isEmpty()) {
    return PageResults.from(pageResult, List.of());
}

List<Long> articleIds = StreamUtils.toList(pageRecords, Article::getId);
Map<Long, Integer> attachmentCountMap = selectAttachmentCountMap(articleIds);
Map<Long, ReviewRecord> reviewRecordMap = selectReviewRecordMap(articleIds);

IPage<ArticlePageVO> page = pageResult.convert(article -> {
    ArticlePageVO data = new ArticlePageVO();
    data.setArticleId(article.getId());
    data.setTitle(article.getTitle());
    data.setAttachmentCount(attachmentCountMap.getOrDefault(article.getId(), 0));
    ReviewRecord reviewRecord = reviewRecordMap.get(article.getId());
    if (reviewRecord != null) {
        data.setSubmitReviewTime(reviewRecord.getSubmitReviewTime());
    }
    return data;
});
return PageResults.from(page, page.getRecords());
```

## Mapper And SQL Style

- Write SQL keywords in lowercase unless the local project standard says otherwise.
- Prefer this Mapper signature for custom pagination:

```java
Page<Article> selectPendingPage(Page<?> page, @Param("query") ArticlePageQuery query);
```

- Keep primary pagination SQL focused on required filtering, ordering, and pagination.
- Prefer explicit single-table queries and batch follow-up queries over JOIN-heavy page queries.
- Allow JOINs or projection Result types only when database-side filtering, sorting, aggregation, or result shape cannot be reasonably expressed by entity queries plus Service assembly.
- For dynamic MyBatis XML, wrap the statement with formatter guards when the project uses them:

```xml
<!--@formatter:off-->
<select id="selectPendingPage" resultType="com.example.Article">
  select id,
         title,
         create_user_id,
         create_time
  from article
  where status = 'PENDING'
  <if test="query.keyword != null and query.keyword != ''">
    and title like concat('%', #{query.keyword}, '%')
  </if>
  order by id desc
</select>
<!--@formatter:on-->
```

- Keep Mapper names, JavaDoc, result types, and SQL behavior aligned after refactors.
- Avoid `select *` when the local project requires explicit columns or when column drift can affect mapping. Use it only when the entity mapping and local convention explicitly tolerate it.

## Review Checklist

- Check whether a Mapper query is returning a VO or a one-off display projection that should be assembled in Service instead.
- Check whether custom pagination Mapper parameters use `Page<?>` and return the concrete `Page<T>` result type.
- Check whether Service code avoids a separate temporary `page` input variable and uses `pageResult` consistently after the Mapper call.
- Check whether SQL is doing UI composition that can be expressed as entity queries plus Service maps.
- Check whether a Result class is justified by projection, aggregation, or unavoidable query shape.
- Check whether pagination metadata is preserved when converting records.
- Check whether empty pages avoid unnecessary auxiliary queries.
- Check whether stream chains hide important steps that would read better as named local variables.
- Check whether Mapper comments, method names, and result types still describe the current responsibility.
