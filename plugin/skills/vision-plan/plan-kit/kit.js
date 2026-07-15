/* plan-kit — vendored JS enhancers for Agentrix visual plan artifacts.
 *
 * HARD CONTRACT: this file (and any plan.js built on it) must never generate,
 * inject, or reveal content. All reviewable content exists statically in the
 * HTML. These enhancers only toggle emphasis classes (.pk-dim / .pk-lit /
 * .active) — opacity and outline only, so document height never changes and
 * review markers never drift. Everything must remain visible and selectable
 * with JS disabled.
 *
 * Vendor as plan/js/kit.js. Auto-initializes on DOMContentLoaded via data-kit
 * attributes:
 *
 *   Path toggle — dims elements whose data-path doesn't match the chosen path:
 *     <div data-kit="paths">
 *       <nav class="pk-path-toggle">
 *         <button data-path-choice="happy" class="active">Happy</button>
 *         <button data-path-choice="failure">Failure</button>
 *         <button data-path-choice="">All</button>
 *       </nav>
 *       ... elements tagged data-path="happy" / data-path="failure" /
 *           data-path="happy failure" (space-separated = on both paths) ...
 *     </div>
 *     Toggles affect [data-path] elements inside the container by default;
 *     declare data-kit-scope="document" on the container to affect the whole
 *     document (e.g. when a rail in another section shares the same paths).
 *
 *   Stepper — highlights one step at a time, dims the rest:
 *     <div data-kit="stepper">
 *       <nav class="pk-path-toggle">
 *         <button data-step-prev>&larr;</button><button data-step-next>&rarr;</button>
 *       </nav>
 *       ... elements tagged data-step="1" ... data-step="n" ...
 *     </div>
 *
 *   Ref link — hovering any [data-ref] element outlines every element bound
 *   to the same plan-data entry (enabled globally, no markup needed).
 */
(function () {
  "use strict";

  function initPaths(root) {
    var scope = root.getAttribute("data-kit-scope") === "document" ? document : root;
    var buttons = root.querySelectorAll("[data-path-choice]");
    var targets = scope.querySelectorAll("[data-path]");
    function apply(choice) {
      buttons.forEach(function (button) {
        button.classList.toggle("active", button.getAttribute("data-path-choice") === choice);
      });
      targets.forEach(function (target) {
        var paths = (target.getAttribute("data-path") || "").split(/\s+/);
        target.classList.toggle("pk-dim", Boolean(choice) && paths.indexOf(choice) === -1);
      });
    }
    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        apply(button.getAttribute("data-path-choice") || "");
      });
    });
    var initial = root.querySelector("[data-path-choice].active");
    if (initial) apply(initial.getAttribute("data-path-choice") || "");
  }

  function initStepper(root) {
    var steps = Array.prototype.slice.call(root.querySelectorAll("[data-step]"));
    var max = steps.reduce(function (top, step) {
      return Math.max(top, Number(step.getAttribute("data-step")) || 0);
    }, 0);
    var current = 0; // 0 = all steps equally visible
    function apply() {
      steps.forEach(function (step) {
        var index = Number(step.getAttribute("data-step")) || 0;
        step.classList.toggle("active", current !== 0 && index === current);
        step.classList.toggle("pk-dim", current !== 0 && index !== current);
      });
    }
    root.querySelectorAll("[data-step-next]").forEach(function (button) {
      button.addEventListener("click", function () { current = current >= max ? 0 : current + 1; apply(); });
    });
    root.querySelectorAll("[data-step-prev]").forEach(function (button) {
      button.addEventListener("click", function () { current = current <= 0 ? max : current - 1; apply(); });
    });
  }

  function initRefLinks() {
    document.addEventListener("mouseover", function (event) {
      var source = event.target instanceof Element ? event.target.closest("[data-ref]") : null;
      if (!source) return;
      var ref = source.getAttribute("data-ref");
      document.querySelectorAll("[data-ref=\"" + ref.replace(/"/g, "\\\"") + "\"]").forEach(function (twin) {
        twin.classList.add("pk-lit");
      });
    });
    document.addEventListener("mouseout", function (event) {
      var source = event.target instanceof Element ? event.target.closest("[data-ref]") : null;
      if (!source) return;
      document.querySelectorAll(".pk-lit").forEach(function (lit) {
        lit.classList.remove("pk-lit");
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-kit=\"paths\"]").forEach(initPaths);
    document.querySelectorAll("[data-kit=\"stepper\"]").forEach(initStepper);
    initRefLinks();
  });
})();
