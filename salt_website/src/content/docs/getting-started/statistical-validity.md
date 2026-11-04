---
title: Statistical Validity
description: How SALT, RDS, Starfish, BBS-lite, and Snowball address the two biases inherent in link-tracing sampling, and which can produce population-representative estimates.
---

Statistical validity in link-tracing designs is obtained by adjusting for two biases that are caused by the fact that we are traversing a network rather than randomly sampling from the population:

1. **Popularity bias**: Individuals who know many other individuals are more likely to be recruited than people with few social connections.
2. **Seed bias**: Selection of starting individuals (seeds) from which the link tracing proceeds may be biased. If there is a tendency for individuals to be connected with others similar to themselves ([homophily](https://en.wikipedia.org/wiki/Homophily)), this bias can persist to subsequent individuals recruited.

## Adjusting for popularity bias

Popularity bias can be adjusted for by down-weighting the values of popular individuals and up-weighting those of less popular individuals. Every commonly used RDS estimator, Salganik-Heckathorn (RDS-I), Volz-Heckathorn (RDS-II), Gile's Successive Sampling (SS), and the Homophily Configuration Graph (HCG) estimator, adjusts for popularity bias in this way, using each participant's reported social network size (degree).

## Addressing seed bias

Seed bias can be addressed in three ways:

### 1. Long recruitment chains

Start with few seeds and have long recruitment chains so that most of the sample is far from their initial seed. Once a chain is so far from its initial seed that individuals are essentially uncorrelated with the seed, the chain has reached **equilibrium**. At equilibrium there is no seed bias.

This is the traditional RDS strategy, and it requires both that participants be willing to make multiple referrals and that there be sufficient time and budget to allow chains to grow long enough to converge.

### 2. Seeds drawn at random from the population

If seeds can be drawn as a random sample from the population, then the seeds themselves are unbiased, and there is therefore no seed bias in subsequently recruited individuals. This is equivalent to starting the recruitment chain already at equilibrium. 

In practice this is rarely achievable for hidden or stigmatized populations, since drawing a random sample requires a sampling frame, exactly what link-tracing was developed to work around. The exception is when we start the chains from individuals selected from a previous sampling process. This might include a previous RDS survey or an initial Time-Location Sampling stage (as in Starfish).

### 3. Robust estimators

The **Homophily Configuration Graph (HCG)** and **Salganik-Heckathorn (RDS-I)** estimators have been shown to be robust to seed bias ([Fellows 2018](https://doi.org/10.1002/sim.7973)). If these estimators are used, seed bias can be mitigated. It is important to note that this adjustment requires underlying network assumptions that are risky to take for granted. That said, these estimators are recommended when seed bias is of concern.

By contrast, Gile's Successive Sampling and Volz-Heckathorn (RDS-II) only adjust for popularity bias and remain biased when seeds are biased.

## Seed-bias reduction strategies by method

| Method | Long recruitment chains | Seeds start at equilibrium | Robust estimators |
| --- | --- | --- | --- |
| [**SALT**](https://github.com/cdcgov/salt/blob/main/SALT.pdf) | ✅ | <span style="color: #2a9d3a; font-weight: 600;">✅\*</span> | <span style="color: #2a9d3a; font-weight: 600;">With HCG or RDS-I</span> |
| [RDS](https://www.lisagjohnston.com/respondent-driven-sampling) | ✅ | ❌ | <span style="color: #2a9d3a; font-weight: 600;">With HCG or RDS-I</span> |
| [Starfish](https://pubmed.ncbi.nlm.nih.gov/30328063/) | ❌ | ✅ | ❌ |
| [BBS-lite](https://www.unaids.org/en/resources/documents/2024/BBS-lite-tool) | ❌ | ❌ | <span style="color: #2a9d3a; font-weight: 600;">With HCG or RDS-I</span> |
| Snowball | ❌ | ❌ | ❌ |

<span style="font-size: 0.9em; color: #555;">\* Initial seeds in SALT are not at equilibrium, but those selected for re-recruitment via the optional continuous-sampling recruitment pool are.</span>

## SALT Software

The SALT software can be used with any of the sampling designs where recruitment chains are tracked (SALT Sampling, RDS, Starfish, and BBS-lite). The statistical rigor of the study, and hence the statistical validity of its results, depends on how well the implemented design addresses the sources of bias inherent in link-tracing designs. For example, a study with long chains will generally be better than one with short chains, and one that starts from equilibrium will generally be better than one started from biased seeds.


## How SALT Sampling applies these strategies

SALT is designed to apply all three strategies simultaneously:

- **Long chains**: Because SALT is continuous rather than time-boxed, chains can grow long over months or years, well past the point at which traditional RDS studies stop.
- **Seeds drawn from the recruitment pool**: When chains run dry, SALT does not restart with new convenience seeds. Instead the next "seed" is drawn from the [recruitment pool](/management/facilities/#continuous-recruitment-settings), the running list of participants who have already been enrolled. Once the pool has filled with link-traced participants, drawing from it is equivalent to drawing from an equilibrium chain, so the new seed carries no bias.
- **Robust estimators**: SALT [data exports](/management/export-data/) include the coupon-recruitment linkages and self-reported network size needed to compute the HCG or Salganik-Heckathorn (RDS-I) estimator using the `RDS` package in R or RDS-Analyst.

## References

- Fellows IE. *Respondent-driven sampling and the homophily configuration graph.* Statistics in Medicine. 2018;37(31):4747–4766. <https://doi.org/10.1002/sim.7973>
- Salganik MJ, Heckathorn DD. *Sampling and estimation in hidden populations using respondent-driven sampling.* Sociological Methodology. 2004;34(1):193–240.
- Volz E, Heckathorn DD. *Probability based estimation theory for respondent driven sampling.* Journal of Official Statistics. 2008;24(1):79–97.
- Gile KJ. *Improved inference for respondent-driven sampling data with application to HIV prevalence estimation.* Journal of the American Statistical Association. 2011;106(493):135–146.
- Raymond HF, Chen YH, McFarland W. *"Starfish sampling": a novel, hybrid approach to recruiting hidden populations.* Journal of Urban Health. 2019;96(1):55–62. <https://pubmed.ncbi.nlm.nih.gov/30328063/>
- World Health Organization, Joint United Nations Programme on HIV/AIDS. *The bio-behavioural survey "lite": a methodology for monitoring programmes providing HIV, viral hepatitis and sexual health services to people from key populations, Implementation tool.* Geneva: WHO; 2024. <https://www.unaids.org/en/resources/documents/2024/BBS-lite-tool>
