// app.js
// AngularJS (1.x) controller with client-side search (title-first, then content search),
// markdown rendering via marked.js, PDF iframe trust, and simple caching + debounce.

angular.module("retroApp", ["ngSanitize"]).controller("MainCtrl", [
  "$http",
  "$sce",
  "$timeout",
  "$sanitize",
  function ($http, $sce, $timeout, $sanitize) {
    const vm = this;

    // public model
    vm.theme = localStorage.getItem("theme") || "light";
    vm.papers = [];
    vm.filtered = [];
    vm.filteredCount = 0;
    vm.searchQuery = "";
    vm.current = null;
    vm.content = $sce.trustAsHtml("<p>Loading...</p>");

    // internals
    vm._mdCache = {}; // path -> raw markdown text
    vm._htmlCache = {}; // path -> trusted HTML (from marked + $sce)
    vm._debouncePromise = null;
    vm._searchDelay = 300; // ms debounce for typing

    // theme toggle
    vm.toggleTheme = function () {
      vm.theme = vm.theme === "light" ? "dark" : "light";
      localStorage.setItem("theme", vm.theme);
    };

    /* ----------------- URL / remote-open helpers ----------------- */

    // safe URL check: disallow file:, blob:, data:; allow http(s) and relative
    function isSafeUrl(urlStr) {
      try {
        const u = new URL(urlStr, window.location.href);
        if (u.protocol === "file:" || u.protocol === "blob:" || u.protocol === "data:") {
          return false;
        }
        // allow http/https OR same-origin relative urls
        return u.protocol === "http:" || u.protocol === "https:" || u.origin === window.location.origin;
      } catch (e) {
        // If URL constructor fails, allow reasonable relative-looking paths (e.g., papers/foo.md)
        // This regex allows typical path characters; be conservative.
        return /^\s*\/?[\w\-\._~:\/?#[\]@!$&'()*+,;=%]+$/.test(urlStr);
      }
    }

    // update the browser URL ?src=... (replaceState)
    function updateUrlForItem(item) {
      try {
        const url = new URL(window.location.href);
        if (item && item.path) {
          url.searchParams.set("src", item.path);
          if (item.title) url.searchParams.set("title", item.title);
        } else {
          url.searchParams.delete("src");
          url.searchParams.delete("title");
        }
        history.replaceState(null, "", url.toString());
      } catch (e) {
        // ignore URL errors
      }
    }

    // open a remote or relative src URL directly (no manifest required)
    function openFromUrl(src) {
      if (!src || typeof src !== "string") return false;
      if (!isSafeUrl(src)) {
        vm.content = $sce.trustAsHtml("<p>Refused to load unsafe URL.</p>");
        return true;
      }

      // infer type from extension if possible
      const lower = src.split("?")[0].split("#")[0].toLowerCase();
      const isPdf = lower.endsWith(".pdf");
      const isMd = lower.endsWith(".md") || lower.endsWith(".markdown") || !isPdf;

      const transient = {
        title: src.split("/").pop(),
        type: isPdf ? "pdf" : "md",
        path: src,
      };
      vm.current = transient;

      if (isPdf) {
        // embed via iframe (subject to remote X-Frame-Options/CSP)
        try {
          transient._trustedSrc = $sce.trustAsResourceUrl(src);
          vm.content = null;
          updateUrlForItem(transient);
        } catch (e) {
          vm.content = $sce.trustAsHtml("<p>Unable to open PDF (invalid resource URL).</p>");
        }
        return true;
      }

      // markdown: fetch, parse, sanitize (if available), render
      vm.content = $sce.trustAsHtml("<p>Loading remote markdown...</p>");
      $http.get(src).then(
        function (res) {
          const md = res.data || "";
          const html = (typeof marked !== "undefined") ? marked.parse(md) : "<pre>" + vm._escapeHtml(md) + "</pre>";
          const trusted = (typeof $sanitize === "function") ? $sce.trustAsHtml($sanitize(html)) : $sce.trustAsHtml(html);
          vm.content = trusted;
          updateUrlForItem(transient);
        },
        function (err) {
          console.error("Failed to fetch remote markdown:", err);
          vm.content = $sce.trustAsHtml("<p>Failed to load remote markdown. Check CORS or URL.</p>");
        }
      );
      return true;
    }

    /* ----------------- helper: escape HTML fallback ----------------- */
    vm._escapeHtml = function (s) {
      if (!s) return "";
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };

    /* ----------------- Manifest loading & initialization ----------------- */

    // load manifest of papers
    function loadManifest() {
      $http.get("papers/papers.json").then(
        function (res) {
          vm.papers = Array.isArray(res.data) ? res.data : [];
          // normalize (ensure type & path)
          vm.papers = vm.papers.map((p) => ({
            title: p.title || "(untitled)",
            type: (p.type || "md").toLowerCase(),
            path: p.path || "",
          }));
          vm.filtered = vm.papers.slice();
          vm.filteredCount = vm.filtered.length;

          // if src param present prefer it
          const params = new URLSearchParams(window.location.search);
          const srcParam = params.get("src");
          if (srcParam) {
            const opened = openFromUrl(srcParam);
            if (!opened && vm.papers.length) vm.open(vm.papers[0]);
          } else {
            if (vm.papers.length) vm.open(vm.papers[0]);
          }
        },
        // function (err) {
        //   console.error("Failed to fetch papers/papers.json", err);
        //   // try src param even if manifest fetch failed
        //   const params = new URLSearchParams(window.location.search);
        //   const srcParam = params.get("src");
        //   if (srcParam) {
        //     openFromUrl(srcParam);
        //     return;
        //   }
        //   // fallback demo if manifest missing
        //   vm.papers = [
        //     { title: "Sample paper (markdown)", type: "md", path: "papers/sample.md" },
        //     { title: "Sample PDF", type: "pdf", path: "papers/sample.pdf" },
        //   ];
        //   vm.filtered = vm.papers.slice();
        //   vm.filteredCount = vm.filtered.length;
        //   vm.open(vm.papers[0]);
        // },
      );
    }

    /* ----------------- open (overrides old behaviour to update URL) ----------------- */

    vm.open = function (item) {
      vm.current = item;
      vm.content = $sce.trustAsHtml("<p>Loading...</p>");

      if (!item || !item.path) {
        vm.content = $sce.trustAsHtml("<p>Invalid item.</p>");
        updateUrlForItem(null);
        return;
      }

      if (item.type === "pdf") {
        // mark pdf path trusted for iframe (ng-src)
        item._trustedSrc = $sce.trustAsResourceUrl(item.path);
        vm.content = null;
        updateUrlForItem(item);
      } else {
        // markdown -> fetch (or use cache) -> parse + trust
        if (vm._htmlCache[item.path]) {
          vm.content = vm._htmlCache[item.path];
          updateUrlForItem(item);
        } else if (vm._mdCache[item.path]) {
          const html = marked.parse(vm._mdCache[item.path] || "");
          // sanitize if $sanitize available
          const safeHtml = (typeof $sanitize === "function") ? $sce.trustAsHtml($sanitize(html)) : $sce.trustAsHtml(html);
          vm._htmlCache[item.path] = safeHtml;
          vm.content = vm._htmlCache[item.path];
          updateUrlForItem(item);
        } else {
          // fetch markdown
          $http.get(item.path).then(
            function (res) {
              const md = res.data || "";
              vm._mdCache[item.path] = md;
              const html = marked.parse(md);
              const safeHtml = (typeof $sanitize === "function") ? $sce.trustAsHtml($sanitize(html)) : $sce.trustAsHtml(html);
              vm._htmlCache[item.path] = safeHtml;
              // only show if still the current item
              if (vm.current && vm.current.path === item.path) {
                vm.content = vm._htmlCache[item.path];
              }
              updateUrlForItem(item);
            },
            function () {
              vm.content = $sce.trustAsHtml("<p>Failed to load markdown.</p>");
              updateUrlForItem(null);
            },
          );
        }
      }
    };

    // internal helper: check if a paper matches the query (title OR content)
    function titleMatches(p, q) {
      if (!q) return true;
      return (p.title || "").toLowerCase().indexOf(q) !== -1;
    }

    // search function (debounced). Strategy:
    // 1) Immediately filter by title to give fast results.
    // 2) If query not empty, concurrently fetch md contents (if not cached) and include those matches too.
    vm.search = function (query) {
      const q = (query || "").trim().toLowerCase();

      // cancel previous debounce
      if (vm._debouncePromise) {
        $timeout.cancel(vm._debouncePromise);
        vm._debouncePromise = null;
      }

      // immediate quick-filter by title
      if (!q) {
        vm.filtered = vm.papers.slice();
        vm.filteredCount = vm.filtered.length;
        return;
      }

      vm.filtered = vm.papers.filter((p) => titleMatches(p, q));
      vm.filteredCount = vm.filtered.length;

      // schedule deeper content search after short delay (debounce)
      vm._debouncePromise = $timeout(function () {
        // find papers not already matched where type===md, attempt to fetch their markdown (if not fetched)
        const needFetch = vm.papers.filter((p) => {
          return !titleMatches(p, q) && p.type === "md" && !vm._mdCache[p.path];
        });

        // fetch those (in parallel) and then run full-content scan
        const fetchPromises = needFetch.map((p) => {
          return $http.get(p.path).then(
            function (res) {
              vm._mdCache[p.path] = res.data || "";
            },
            function () {
              vm._mdCache[p.path] = ""; // failed -> empty
            },
          );
        });

        // when all fetches done (or immediately if none), scan content for matches
        Promise.all(fetchPromises).then(function () {
          const contentMatches = vm.papers.filter((p) => {
            if (titleMatches(p, q)) return false; // already included
            if (p.type !== "md") return false;
            const md = vm._mdCache[p.path] || "";
            return md.toLowerCase().indexOf(q) !== -1;
          });
          // combine title matches + contentMatches
          vm.filtered = vm.papers
            .filter((p) => titleMatches(p, q))
            .concat(contentMatches);
          // remove duplicates (in case)
          const seen = new Set();
          vm.filtered = vm.filtered.filter((p) => {
            if (seen.has(p.path)) return false;
            seen.add(p.path);
            return true;
          });
          vm.filteredCount = vm.filtered.length;
          // Angular digest may be needed because Promise.then is outside Angular zone
          try {
            $timeout(() => {}, 0);
          } catch (e) {}
        });
      }, vm._searchDelay);
    };

    // expose helper used by the template to get trusted iframe src for pdfs
    vm.trustedPdf = function (item) {
      if (!item) return null;
      if (item._trustedSrc) return item._trustedSrc;
      if (item.path) {
        item._trustedSrc = $sce.trustAsResourceUrl(item.path);
        return item._trustedSrc;
      }
      return null;
    };

    // initialize
    (function init() {
      const params = new URLSearchParams(window.location.search);
      const srcParam = params.get("src");
      if (srcParam) {
        const ok = openFromUrl(srcParam);
        if (!ok) {
          loadManifest();
        }
      } else {
        loadManifest();
      }
    })();
  },
]);

