<script lang="ts">
  import "./fonts.css";
  import "../src/tokens.css";

  import CatalogScenario from "./CatalogScenario.svelte";
  import {
    catalogFixtureStates,
    catalogFixtures,
    catalogScenarioKey,
    type CatalogFixture,
  } from "./fixtures";

  type Props = {
    theme?: "light" | "dark";
    direction?: "ltr" | "rtl";
    compact?: boolean;
    wide?: boolean;
    fixtures?: readonly CatalogFixture[];
  };

  let {
    theme = "light",
    direction = "ltr",
    compact = false,
    wide = false,
    fixtures = catalogFixtures,
  }: Props = $props();
</script>

<main
  class="catalog"
  class:compact
  class:wide
  data-spark-theme={theme}
  data-testid="catalog-gallery"
  dir={direction}
>
  <header class="catalog-header">
    <div>
      <p class="eyebrow">Spark internal UI kit</p>
      <h1>Component catalog</h1>
    </div>
    <p class="catalog-summary">
      Protocol-neutral presentation fixtures for conversation and agent workbench surfaces.
    </p>
  </header>

  <nav aria-label="Catalog components">
    {#each fixtures as fixture (fixture.id)}
      <a href={`#${fixture.id}`}>{fixture.title}</a>
    {/each}
  </nav>

  <section class="catalog-grid" aria-label="Component previews">
    {#each fixtures as fixture (fixture.id)}
      <article
        class="catalog-card"
        id={fixture.id}
        data-catalog-fixture={fixture.id}
        data-testid={`catalog-${fixture.id}`}
      >
        <header class="fixture-header">
          <div>
            <p class="fixture-group">{fixture.group}</p>
            <h2>{fixture.title}</h2>
          </div>
          <div class="state-list" aria-label={`${fixture.title} fixture states`}>
            {#each catalogFixtureStates(fixture) as state}
              <span>{state}</span>
            {/each}
          </div>
        </header>
        <p class="fixture-description">{fixture.description}</p>

        <div class="scenario-grid">
          {#each fixture.scenarios as scenario (scenario.id)}
            <section
              class="scenario"
              data-catalog-scenario={catalogScenarioKey(fixture, scenario)}
              data-testid={`catalog-${fixture.id}-${scenario.id}`}
              aria-label={`${fixture.title}: ${scenario.title}`}
            >
              <header class="scenario-header">
                <h3>{scenario.title}</h3>
                <span>{scenario.state}</span>
              </header>
              <div class="preview" data-preview={catalogScenarioKey(fixture, scenario)}>
                <CatalogScenario fixtureId={fixture.id} {scenario} />
              </div>
            </section>
          {/each}
        </div>
      </article>
    {/each}
  </section>
</main>

<style>
  :global(body) {
    min-width: 320px;
  }

  .catalog {
    --font-sans: "Spark Catalog Inter", sans-serif;

    background: var(--color-canvas);
    color: var(--color-ink);
    font-family: var(--font-sans);
    min-height: 100vh;
    padding: clamp(18px, 4vw, 48px);
  }

  .catalog-header {
    align-items: end;
    display: grid;
    gap: 24px;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 0.7fr);
    margin: 0 auto;
    max-width: 1120px;
  }

  .eyebrow,
  .fixture-group {
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    margin: 0 0 6px;
    text-transform: uppercase;
  }

  h1,
  h2,
  p {
    margin-top: 0;
  }

  h1 {
    font-size: clamp(26px, 4vw, 40px);
    letter-spacing: -0.03em;
    margin-bottom: 0;
  }

  h2 {
    font-size: 16px;
    margin-bottom: 0;
  }

  h3 {
    font-size: 12px;
    margin: 0;
  }

  .catalog-summary,
  .fixture-description {
    color: var(--color-ink-muted);
    line-height: 1.6;
  }

  .scenario-grid {
    display: grid;
    gap: 12px;
  }

  .scenario {
    min-width: 0;
  }

  .scenario-header {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .scenario-header span {
    color: var(--color-ink-subtle);
    font-size: 10px;
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 28px auto 20px;
    max-width: 1120px;
  }

  nav a {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    font-size: 12px;
    padding: 7px 11px;
    text-decoration: none;
  }

  nav a:hover {
    border-color: var(--color-border-strong);
    color: var(--color-ink);
  }

  .catalog-grid {
    display: grid;
    gap: 18px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin: 0 auto;
    max-width: 1120px;
  }

  .catalog-card {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-xl);
    box-shadow: var(--shadow-card);
    min-width: 0;
    padding: 18px;
  }

  .fixture-header {
    align-items: start;
    display: flex;
    gap: 16px;
    justify-content: space-between;
  }

  .state-list {
    display: grid;
    gap: 4px;
    grid-template-columns: repeat(4, max-content);
    justify-content: end;
    min-width: 0;
  }

  .state-list span {
    background: var(--color-surface-soft);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    font-size: 10px;
    padding: 3px 6px;
  }

  .fixture-description {
    font-size: 12px;
    margin: 10px 0 16px;
  }

  .preview {
    background: var(--color-canvas);
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--rounded-lg);
    min-width: 0;
    overflow: hidden;
    padding: 16px;
  }

  .preview :global(form) {
    margin: 0;
  }

  @media (max-width: 760px) {
    .catalog-header,
    .catalog-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .catalog-header {
      gap: 10px;
    }

    .fixture-header {
      display: grid;
    }

    .state-list {
      justify-content: start;
    }
  }

  .catalog.compact {
    max-width: 420px;
  }

  .catalog.compact .catalog-header,
  .catalog.compact .catalog-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .catalog.compact .catalog-header {
    gap: 10px;
  }

  .catalog.compact .fixture-header {
    display: grid;
  }

  .catalog.compact .state-list {
    justify-content: start;
  }

  .catalog.wide {
    width: 1024px;
  }

</style>
