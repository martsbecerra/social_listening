// ==========================================================================
// kpis.js — Umbrales y sentimiento ponderado de X (Prompt Grok).
// Instagram usa src/sentimentAggregate.js; este archivo no lo toca.
// ==========================================================================

const ACCOUNT_WEIGHT = {
  oficial: 2.5,
  periodista: 2.0,
  opositor: 1.8,
  vecino: 1.0,
};

const PERFORMANCE_LEVELS = ['Bajo', 'Medio', 'Alto', 'Muy Alto'];

function levelFromViews(views) {
  if (views == null || Number.isNaN(Number(views))) return null;
  const v = Number(views);
  if (v < 45_000) return 0;
  if (v <= 60_000) return 1;
  if (v <= 100_000) return 2;
  return 3;
}

function levelFromInteractions(interactions) {
  if (interactions == null || Number.isNaN(Number(interactions))) return null;
  const i = Number(interactions);
  if (i < 600) return 0;
  if (i <= 1500) return 1;
  if (i <= 2500) return 2;
  return 3;
}

function computePostInteractions(post) {
  if (!post) return null;
  const likes = post.likes;
  const retweets = post.retweets;
  const quotes = post.quotes;
  const replies = post.replies;
  if (likes == null && retweets == null && quotes == null && replies == null) return null;
  return Number(likes || 0) + Number(retweets || 0) + Number(quotes || 0) + Number(replies || 0);
}

function levelLabel(index) {
  if (index == null) return 'N/D';
  return PERFORMANCE_LEVELS[index] ?? 'N/D';
}

function computePerformanceLevels(post) {
  const viewsLevel = levelFromViews(post?.views);
  const interactions = computePostInteractions(post);
  const interactionsLevel = levelFromInteractions(interactions);
  return {
    viewsLevel: levelLabel(viewsLevel),
    interactionsLevel: levelLabel(interactionsLevel),
    interactions,
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * VP = Σ (RTs_pos × Wc) + likes_pos
 * VN = Σ (RTs_neg × Wc) + replies_neg
 * positivo% = min(round(base + 5), 100)
 *
 * @param {Array} sample
 * @param {Array<{ sentiment: string, accountType: string }>} classifications
 */
function computeWeightedSentimentPercentages(sample, classifications) {
  let weightedPos = 0;
  let weightedNeg = 0;

  const n = Math.min(sample.length, classifications.length);
  for (let i = 0; i < n; i++) {
    const item = sample[i] || {};
    const row = classifications[i] || {};
    const { sentiment, accountType } = row;
    if (sentiment === 'neutral' || sentiment === 'ruido' || accountType === 'ruido') {
      continue;
    }
    if (sentiment !== 'positivo' && sentiment !== 'negativo') continue;

    const weight = ACCOUNT_WEIGHT[accountType] ?? ACCOUNT_WEIGHT.vecino;
    const rtTerm = num(item.retweets) * weight;
    if (sentiment === 'positivo') {
      weightedPos += rtTerm + num(item.likes);
    } else {
      weightedNeg += rtTerm + num(item.replies);
    }
  }

  const total = weightedPos + weightedNeg;
  if (total === 0) {
    return { positivoPct: 50, negativoPct: 50, weightedPos: 0, weightedNeg: 0 };
  }

  const base = (weightedPos / total) * 100;
  let positivoPct = Math.round(base + 5);
  if (positivoPct < 0) positivoPct = 0;
  if (positivoPct > 100) positivoPct = 100;
  return {
    positivoPct,
    negativoPct: 100 - positivoPct,
    weightedPos,
    weightedNeg,
  };
}

module.exports = {
  ACCOUNT_WEIGHT,
  PERFORMANCE_LEVELS,
  parseCount: require('./parseCount').parseCount,
  levelFromViews,
  levelFromInteractions,
  computePostInteractions,
  computePerformanceLevels,
  computeWeightedSentimentPercentages,
};
