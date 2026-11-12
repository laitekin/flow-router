import assert from "node:assert/strict"
import test from "node:test"
import {
  BROWSER_IMPORT_SNIPPET,
  draftMissing,
  draftTokenCredential,
  emptyDraft,
  hostOf,
  parseImportJSON,
  parseImportLines,
} from "./channel-import.ts"

test("parseImportJSON reads browser snippet output", () => {
  const d = parseImportJSON(
    JSON.stringify({ flow_router_import: 1, site_url: "https://a.com", type: "sub2api", access_token: "at", refresh_token: "rt", username: "x@y.z" }),
  )
  assert.ok(d)
  assert.equal(d.type, "sub2api")
  assert.equal(d.credential_mode, "token")
  assert.equal(d.refresh_token, "rt")
  assert.equal(parseImportJSON('{"foo":1}'), null)
  assert.equal(parseImportJSON("https://a.com"), null)
})

test("parseImportLines handles mixed separators, json and comments", () => {
  const rows = parseImportLines(
    [
      "# comment",
      "https://a.com user1 pass word",
      "b.com,user2,p2",
      "c.com|user3|p3",
      "d.com----user4----p4",
      "e.com",
      JSON.stringify({ flow_router_import: 1, site_url: "https://f.com", type: "newapi", access_token: "t", user_id: 9 }),
      "",
    ].join("\n"),
  )
  assert.equal(rows.length, 6)
  assert.deepEqual([rows[0].site_url, rows[0].username, rows[0].password], ["https://a.com", "user1", "pass word"])
  assert.deepEqual([rows[1].username, rows[1].password], ["user2", "p2"])
  assert.deepEqual([rows[2].username, rows[2].password], ["user3", "p3"])
  assert.deepEqual([rows[3].username, rows[3].password], ["user4", "p4"])
  assert.equal(rows[4].username, "")
  assert.equal(rows[5].user_id, "9")
  assert.equal(rows[5].type, "newapi")
})

test("draftTokenCredential matches backend credential shapes", () => {
  const d = emptyDraft({ access_token: " at ", refresh_token: "", user_id: "3" })
  assert.equal(draftTokenCredential(d, "sub2api"), '{"access_token":"at"}')
  assert.equal(draftTokenCredential(d, "newapi"), '{"access_token":"at","user_id":"3"}')
})

test("draftMissing explains what is missing", () => {
  assert.equal(draftMissing(emptyDraft({ site_url: "a.com" }), undefined), "未识别站点类型")
  assert.equal(draftMissing(emptyDraft({ site_url: "a.com", username: "u" }), "sub2api"), "缺少密码")
  assert.equal(draftMissing(emptyDraft({ site_url: "a.com", credential_mode: "token", access_token: "t" }), "newapi"), "缺少 User ID")
  assert.equal(draftMissing(emptyDraft({ site_url: "a.com", username: "u", password: "p" }), "newapi"), null)
})

test("hostOf and snippet sanity", () => {
  assert.equal(hostOf("https://a.com/login"), "a.com")
  assert.equal(hostOf("b.com"), "b.com")
  // 脚本必须是可解析的 JS
  assert.doesNotThrow(() => new Function(BROWSER_IMPORT_SNIPPET))
})
