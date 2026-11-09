/*
GoatCounter hits box: the counting logic behind the sidebar box in
themes/elegant-dev/templates/_includes/visits.html.

Every function here is pure, so tests/test_visits_js.py can run them in node against the
built file. The DOM side is init(), which takes its objects through a deps seam. UMD:
module.exports for the node tests, window.Visits for the page. Times are epoch ms.

The cache is one entry per path: each entry carries its own count and its own age, so a
page load fetches only the paths whose entry is missing or older than FRESH_MS. A cache
that is fresh as a whole does not cover a path it has never fetched, and a fetch does not
make the paths it did not ask for fresh. When a refresh fails, a number stays on the page
while its own age is inside KEEP_MS, 24 hours, and a row outside the window is hidden.

The PDF click binds through one delegated listener on the document, so a link added to the
page after this script runs counts under the same handler as a link already on the page.
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Visits = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var FRESH_MS = 4 * 3600 * 1000;   // a path's entry is fetched again when its own age passes 4 hours
  var KEEP_MS = 24 * 3600 * 1000;    // after a failed refresh, a number is kept for 24 hours from its own fetched_at
  var EVENT_CAP = 255;               // GoatCounter event names cap at 255 characters
  var POLL_TRIES = 100;              // count.js loads async, so the page hit waits for it: 5 seconds
  var POLL_MS = 50;
  // The poll is bounded on purpose: a count.js blocked by an ad blocker never becomes
  // ready, so an unbounded chain would leave a timer running for the whole visit. 1 second
  // gave up on a reader whose async script lands late, so the window is 5 seconds: most
  // late scripts are counted, and a blocked script costs 5 seconds of a dead poll.

  function page_path(pathname) {
    // GoatCounter's own normalization, so the number shown is the number counted.
    return pathname.replace(/\?.*|\.html$/, "");
  }

  function pdf_event_name(href, site_origin) {
    // The name the PDF click is counted under: host + path. #page=5 and the query fall
    // off, {static}/ and {filename}/ are link-source prefixes, not URL parts, a relative
    // href resolves against the site origin, and a hostless scheme (mailto:) binds nothing.
    var target = href.split("#")[0].split("?")[0];
    var prefixes = ["{static}/", "{filename}/"];
    for (var i = 0; i < prefixes.length; i++) {
      if (target.indexOf(prefixes[i]) === 0) {
        target = target.slice(prefixes[i].length);
      }
    }
    var url;
    try {
      url = new URL(target, site_origin);
    } catch (e) {
      return null;
    }
    if (!url.host) {
      return null;
    }
    return (url.host + url.pathname).replace(/^\/+/, "").slice(0, EVENT_CAP);
  }

  function paths_for(path, names) {
    // The counter paths to read: this page, the site total, and every PDF event.
    return [path, "TOTAL"].concat(names);
  }

  function fetch_url(code, path) {
    return "https://" + code + ".goatcounter.com/counter/" + encodeURIComponent(path) + ".json";
  }

  function count_request(code, path, fetch_impl) {
    // One path's counter request as a promise. A browser without fetch throws on the call,
    // which is not a rejection, so the throw becomes a rejection here: the fetch fails, the
    // box hides, and init reaches the page hit and the click listener.
    try {
      return Promise.resolve(fetch_impl(fetch_url(code, path))).then(function (res) {
        if (res.status === 404) {
          return [path, "0"];
        }
        if (!res.ok) {
          throw new Error("the counter refused " + path);
        }
        return res.json().then(function (body) { return [path, body.count]; });
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function fetch_counts(code, paths, fetch_impl) {
    // One counter request per path: a 404 for a path never seen is "0", not a failure.
    // Any other non-ok answer is a failure, 403 when the counter refuses to count, so the
    // whole set has no numbers and the box hides.
    var requests = [];
    for (var i = 0; i < paths.length; i++) {
      requests.push(count_request(code, paths[i], fetch_impl));
    }
    return Promise.all(requests).then(function (pairs) {
      var counts = {};
      for (var i = 0; i < pairs.length; i++) {
        counts[pairs[i][0]] = pairs[i][1];
      }
      return counts;
    }).catch(function () {
      return null;
    });
  }

  function cache_key(code) {
    return "goatcounter:" + code;
  }

  function read_cache(store, code) {
    var raw;
    try {
      raw = store.getItem(cache_key(code));
    } catch (e) {
      // A browser with storage disabled, blocked by ETP, or on a cookie-blocked origin
      // throws on the getter: there is no cache, which is the same as an empty one.
      return null;
    }
    if (!raw) {
      return null;
    }
    var entry;
    try {
      entry = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!entry || !entry.counts || typeof entry.fetched_at !== "number") {
      return null;
    }
    var key;
    for (key in entry.counts) {
      // A cache from the older shape, or a half-written entry, is no cache: the age rule
      // reads each path's own entry, so an entry without a count and a numeric age gives
      // it nothing to read, and the whole cache is dropped.
      var item = entry.counts[key];
      if (!item || typeof item.count !== "string" || typeof item.fetched_at !== "number") {
        return null;
      }
    }
    return entry;
  }

  function write_cache(store, code, counts, fetched_at) {
    // The top-level fetched_at is the write time, not the age of any entry: every entry
    // carries its own. The cache is only a cache: a full quota throws, and so does a store
    // on a browser that blocks storage, so the numbers render for this load and nothing is
    // stored.
    try {
      store.setItem(cache_key(code), JSON.stringify({counts: counts, fetched_at: fetched_at}));
    } catch (e) {
      return;
    }
  }

  function fresh(entry, now) {
    return !!entry && now - entry.fetched_at <= FRESH_MS;
  }

  function stale_paths(paths, counts, now) {
    // The paths this load has to fetch: a path the cache has never answered, and a path
    // whose entry is past FRESH_MS. Fresh paths are rendered as they are, so the page does
    // not refetch a number it is already showing.
    var stale = [];
    for (var i = 0; i < paths.length; i++) {
      if (!fresh(counts[paths[i]], now)) {
        stale.push(paths[i]);
      }
    }
    return stale;
  }

  function merge_fetched(counts, fetched, now) {
    // The fetched counts join the cache as entries stamped now. The paths the fetch did
    // not ask for keep their own fetched_at, so a page's own age is what decides its next
    // fetch, and a page that refreshes the site total does not make every other page fresh.
    var merged = {};
    var key;
    for (key in counts) {
      merged[key] = counts[key];
    }
    for (key in fetched) {
      merged[key] = {count: fetched[key], fetched_at: now};
    }
    return merged;
  }

  function keep_ok(entry, now) {
    // A fetch failure always follows a refresh, so the keep window has to reach the ages a
    // refresh can leave behind: a 10-minute window was never true after a fetch, and the
    // rule that keeps the numbers on a failed refresh never ran. 24 hours covers a reader
    // who stays on a page past the 4-hour fetch age and refreshes at the counter being down.
    return !!entry && now - entry.fetched_at <= KEEP_MS;
  }

  function kept_paths(paths, counts, now) {
    // The rows a failed refresh can show: a path's own entry, inside the keep window. A
    // path with no entry inside the window gets no number, so its row is hidden.
    var kept = {};
    for (var i = 0; i < paths.length; i++) {
      if (keep_ok(counts[paths[i]], now)) {
        kept[paths[i]] = counts[paths[i]];
      }
    }
    return kept;
  }

  function format_count(n) {
    return new Intl.NumberFormat("en-GB").format(n);
  }

  function count_number(value) {
    // Counter counts come as strings with thousands separators, and the separator is locale
    // dependent (comma, space, dot), so the PDF sum strips every non-digit: parseInt of a
    // space- or dot-formatted count reads only the first group.
    return parseInt(String(value).replace(/\D/g, ""), 10) || 0;
  }

  function count_of(counts, path) {
    // The count string a cached path carries, or null when the cache has no entry for it.
    var entry = counts[path];
    return entry ? entry.count : null;
  }

  function text_for(counts, path, pdf_names) {
    // The three numbers, as strings, with null meaning the slot is hidden. The PDF number
    // is the site-wide sum over the counted events, and a site with no PDF links shows no
    // PDF row at all. Every number reads its own path's entry, so a cache that has this
    // page's path shows this page's number.
    if (!counts) {
      return {page: null, site: null, pdf: null};
    }
    var texts = {page: count_of(counts, path), site: count_of(counts, "TOTAL"), pdf: null};
    if (pdf_names.length) {
      var sum = 0;
      for (var i = 0; i < pdf_names.length; i++) {
        sum += count_number(count_of(counts, pdf_names[i]));
      }
      texts.pdf = format_count(sum);
    }
    return texts;
  }

  function record_page_hit(deps, path, tries) {
    // window.goatcounter starts as the config object the include writes, and count.js adds
    // its count function when the async script arrives, so the page hit is recorded once
    // the script is ready. A blocked script never gets ready, so the tries run out. In a
    // browser with storage disabled, count.js's own filter() throws on the localStorage
    // getter, so count() throws here: the page hit is lost, and init has to reach the PDF
    // bind loop, so the throw is caught and the page keeps its content.
    var goatcounter = deps.get_goatcounter();
    if (goatcounter && goatcounter.count) {
      try {
        goatcounter.count({path: path});
      } catch (e) {
        return;
      }
    } else if (tries < POLL_TRIES && typeof setTimeout === "function") {
      setTimeout(function () { record_page_hit(deps, path, tries + 1); }, POLL_MS);
    }
  }

  function count_pdf(name, goatcounter) {
    // A PDF click is an event, counted under the name the PDF set sums. The counter script
    // can be blocked by an ad blocker, so the click counts only when it is ready, and a
    // ready script whose count() throws on blocked storage must not raise out of the click
    // listener: the click is dropped, the page is untouched.
    if (name && goatcounter && goatcounter.count) {
      try {
        goatcounter.count({path: name, event: true, title: "PDF"});
      } catch (e) {
        return;
      }
    }
  }

  function init(deps) {
    // One pass over the deps: numbers from cache or counter, the page hit, the click
    // listener. The cache is per path, so this load fetches the paths with no entry or an entry past
    // FRESH_MS, merges what the counter answers into the cached map, and renders the merge.
    // A refresh that fails renders the rows whose own age is inside KEEP_MS and hides the
    // rest, so a counter outage does not empty the box for a day.
    // Returns the fetch promise when a fetch runs, so the tests can await the render; the
    // include ignores it. A null store means storage is blocked, so the cache rule gives
    // no numbers and the box hides, while the page hit and the PDF clicks still count.
    var path = page_path(deps.pathname);
    var paths = paths_for(path, deps.pdf_names);
    var loading = null;
    if (!deps.store) {
      deps.render(null);
    } else {
      var cached = read_cache(deps.store, deps.code);
      var counts = cached ? cached.counts : {};
      var stale = cached ? stale_paths(paths, counts, deps.now()) : paths;
      if (cached && !stale.length) {
        deps.render(text_for(counts, path, deps.pdf_names));
      } else {
        loading = fetch_counts(deps.code, stale, deps.fetch_impl).then(function (fetched) {
          if (fetched) {
            var merged = merge_fetched(counts, fetched, deps.now());
            write_cache(deps.store, deps.code, merged, deps.now());
            deps.render(text_for(merged, path, deps.pdf_names));
          } else if (cached) {
            var kept = kept_paths(paths, counts, deps.now());
            deps.render(Object.keys(kept).length ? text_for(kept, path, deps.pdf_names) : null);
          } else {
            deps.render(null);
          }
        });
      }
    }
    record_page_hit(deps, path, 0);
    deps.bind_delegated(function (event) {
      // One listener on the document, so a link added to the page after this script runs
      // counts under the same handler as a link that was already there. The raw href
      // attribute is what the page wrote, so a fragment (#page=5) and a root-relative path
      // give the name the PDF set carries for the plain link.
      var link = event.target && event.target.closest && event.target.closest("a");
      if (!link) {
        return;
      }
      var name = pdf_event_name(link.getAttribute("href"), deps.origin);
      if (name && deps.pdf_names.indexOf(name) !== -1) {
        count_pdf(name, deps.get_goatcounter());
      }
    });
    return loading;
  }

  return {
    page_path: page_path,
    pdf_event_name: pdf_event_name,
    paths_for: paths_for,
    fetch_url: fetch_url,
    fetch_counts: fetch_counts,
    cache_key: cache_key,
    read_cache: read_cache,
    write_cache: write_cache,
    fresh: fresh,
    keep_ok: keep_ok,
    format_count: format_count,
    count_number: count_number,
    text_for: text_for,
    init: init,
    count_pdf: count_pdf
  };
}));
