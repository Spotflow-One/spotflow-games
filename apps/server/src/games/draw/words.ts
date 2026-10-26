import type { WordListSummary } from "@spotflow-games/shared";

export interface WordList {
  id: string;
  title: string;
  words: string[];
}

const list = (id: string, title: string, words: string) => ({
  id,
  title,
  words: words
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean),
});

/** Drawable words, chosen to be guessable by a mixed, international team. */
const CURATED: WordList[] = [
  list(
    "curated:animals",
    "Animals",
    "cat, dog, elephant, giraffe, lion, snake, fish, bird, butterfly, spider, horse, cow, pig, rabbit, turtle, frog, monkey, owl, penguin, shark, whale, crab, bee, snail, zebra, camel, octopus, duck, chicken, mouse, bat, crocodile, kangaroo, parrot, goat",
  ),
  list(
    "curated:food",
    "Food and drink",
    "pizza, banana, apple, burger, ice cream, cake, bread, egg, carrot, pineapple, coffee, tea, sandwich, cheese, cookie, watermelon, popcorn, noodles, rice, corn, grapes, orange, lemon, chocolate, doughnut, hot dog, mango, coconut, pepper, tomato, plantain, jollof rice, avocado, honey",
  ),
  list(
    "curated:everyday",
    "Everyday things",
    "chair, table, umbrella, clock, key, door, window, bed, lamp, phone, book, glasses, shoe, hat, bicycle, car, house, tree, sun, moon, star, cloud, rain, rainbow, mountain, bridge, boat, airplane, train, ball, guitar, camera, candle, ladder, scissors, toothbrush, backpack, balloon, kite, flower",
  ),
  list(
    "curated:work",
    "Work and tech",
    "laptop, keyboard, mouse pad, email, calendar, meeting, coffee break, headphones, microphone, rocket, robot, cloud, wifi, battery, password, bug, credit card, wallet, receipt, chart, calculator, printer, sticky note, deadline, holiday, desk, office, video call, trophy, lightbulb, magnet, briefcase, piggy bank, money, globe",
  ),
];

const MIXED: WordList = {
  id: "curated:mixed",
  title: "Mixed bag",
  words: [...new Set(CURATED.flatMap((l) => l.words))],
};

export const CURATED_WORD_LISTS: WordList[] = [MIXED, ...CURATED];

export interface WordSource {
  get(id: string): Promise<WordList | null>;
  list(): Promise<WordListSummary[]>;
}

/** Curated lists only. Custom, shared word lists will join this source. */
export const curatedWordSource: WordSource = {
  async get(id) {
    return CURATED_WORD_LISTS.find((l) => l.id === id) ?? null;
  },
  async list() {
    return CURATED_WORD_LISTS.map((l) => ({ id: l.id, title: l.title, wordCount: l.words.length, curated: true }));
  },
};
