# 🔍 Code Review Report

## Summary

| Metric | Value |
|--------|-------|
| **Overall Score** | 0/100 |
| **Files Reviewed** | 1 |
| **Critical Issues** | 3 |
| **High Priority Tests** | 5 |
| **Refactoring Opportunities** | 5 |

## 🎯 Top Recommendations

1. 🚨 **Security - SQL Injection**: Fix SQL injection vulnerability in searchTodos (line 120): replace direct string interpolation with parameterized query using placeholders ($1, $2) to prevent arbitrary SQL execution.
   - Files: src/todo.ts

2. 🚨 **Security - SQL Injection**: Fix SQL injection vulnerability in searchTodosByStatus (line 131): replace string concatenation with parameterized query and change parameter type from string to boolean.
   - Files: src/todo.ts

3. 🚨 **Security - SQL Injection**: Fix SQL injection vulnerability in getTodosByUser (line 142): replace template literal interpolation with parameterized query to prevent unauthorized data access and SQL manipulation.
   - Files: src/todo.ts

4. 🚨 **Testing**: Add unit tests for searchTodos covering happy path (keyword matching in title/description), empty string input, SQL wildcard characters, and case sensitivity. Currently 0% test coverage for new functionality.
   - Files: src/todo.ts

5. 🚨 **Testing**: Add unit tests for searchTodosByStatus covering completed/incomplete filtering and invalid input handling. Function has type mismatch (accepts string instead of boolean) that will cause runtime failures.
   - Files: src/todo.ts

## 📁 File Details

### 📄 `src/todo.ts`

**Quality Score:** 0/100 | **Coverage:** ~0%

#### Issues (10)
  - Line 120: `critical` SQL injection vulnerability: user-controlled `keyword` is directly interpolated into the SQL query using template literals. An attacker can inject arbitrary SQL (e.g., `keyword = "' OR '1'='1"`) to read, modify or delete data.
  - Line 131: `critical` SQL injection vulnerability: user-controlled `completed` parameter is directly concatenated into the SQL query. An attacker can pass `completed = "1 OR 1=1"` to bypass the filter or execute malicious SQL.
  - Line 142: `critical` SQL injection vulnerability: `userId` is embedded in the query using template literals without sanitization. An attacker can pass `userId = "' OR '1'='1"` to access all users' todos or execute arbitrary SQL including data exfiltration or deletion.

  *...and 7 more*

#### Test Gaps (8)
  - `searchTodos in src/todo.ts (lines 118-123)` (critical priority)
  - `searchTodos in src/todo.ts (lines 118-123)` (high priority)

  *...and 6 more*

#### Refactoring Opportunities (5)
  - **extract-function**: Extract repeated SQL query pattern into a helper function. All three new search functions follow the same execute-and-return pattern but use unsafe string concatenation. Even after fixing the security issues (which the code-quality agent will flag), extracting the query execution removes duplication.
  - **modernize**: Replace string concatenation with template literal for consistency. The file uses template literals elsewhere (lines 116, 143), but line 127 uses the older + operator. Even though this entire line will be replaced when fixing the SQL injection, maintaining consistent style during intermediate refactors improves readability.

  *...and 3 more*

---

*Generated at 2026-09-30T17:35:00Z • Duration: 45ms*
