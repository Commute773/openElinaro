# SWE-bench Difficulty Analysis

This note describes the local analysis CLI for deriving task difficulty and harness ability scores from published SWE-bench Verified submissions.

## What It Uses

- local clone of [`references/swe-bench-experiments`](../../references/swe-bench-experiments)
- public `results/results.json` artifacts under `evaluation/verified/`
- no local SWE-bench evaluation run
- no Docker benchmark execution

## Command

```bash
bun run benchmark:swebench:verified:difficulty
```

Optional knobs:

- `--min-submission-coverage <n>` filters out sparse submissions
- `--min-task-attempts <n>` filters out poorly observed tasks
- `--laplace-alpha <n>` and `--laplace-beta <n>` control solve-rate smoothing
- `--top <n>` changes how many hardest tasks and top-scoring submissions are printed

The full JSON analysis is written under `~/.openelinaro/benchmarks/swebench/verified-difficulty/`.

The default coverage filter is `450` tasks. This avoids over-weighting partial or right-censored submissions whose checked-in `results.json` omits most failures.
For a modern-public-results view, a lower threshold such as `150` includes many more 2025 submissions, but the comparison becomes less apples-to-apples.

## Method

The analysis now produces two complementary difficulty views.

Empirical task difficulty:

- collect every submission's attempted tasks from the union of arrays in `results/results.json`
- treat the `resolved` array as success and all other listed outcomes as non-resolved attempts
- compute each task's solve rate across included submissions
- smooth the solve rate with a Laplace prior and define difficulty as `1 - smoothed_solve_rate`

Latent task and harness scoring:

- fit a regularized Rasch / 1PL IRT model over the observed success matrix
- estimate one latent ability value per submission and one latent difficulty value per task
- derive approximate standard errors from the local Fisher information
- rank submissions by a conservative lower bound: `latentAbilityLowerBound95 = latentAbility - 1.96 * latentAbilityStdError`

The output still includes the older frontier heuristic:

- predict that a submission solves tasks up to some empirical-difficulty threshold and fails above it
- search for the threshold that best separates the submission's solved versus failed tasks
- score that threshold with balanced accuracy

That `failureFrontierDifficulty` is still useful as a descriptive summary, but the primary ranking signal is now the conservative latent ability bound.

If a submission has no recorded failures and covers fewer tasks than the filtered benchmark universe, it is marked `isRightCensored` in the output.

Read `latentAbilityLowerBound95` together with `solveRate`, `isRightCensored`, and `attemptedCount`. Read `failureFrontierDifficulty` together with `solveRate` and `thresholdBalancedAccuracy`; it is a one-dimensional empirical cutoff summary, not a replacement for overall resolution rate.
