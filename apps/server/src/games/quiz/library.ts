import type { QuizQuestion, QuizSummary } from "@spotflow-games/shared";
import { AFRICA, GENERAL, MONEY, TECH } from "./banks/index.js";

export interface CuratedQuiz {
  id: string;
  title: string;
  description: string;
  questions: QuizQuestion[];
}

const q = (prompt: string, options: string[], correctIndex: number): QuizQuestion => ({
  prompt,
  options,
  correctIndex,
});

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

const NUMBER = /^-?[\d,.]+[°%]?$/;
const toNumber = (option: string) => parseFloat(option.replace(/,/g, ""));

/**
 * Parses a question bank: one question per line, as "prompt | right answer | wrong | wrong | wrong".
 * Numbers are listed in order. Otherwise the right answer's position comes from a hash of the
 * question, so answers are spread across A to D and stay put between restarts.
 */
export function parseBank(text: string): QuizQuestion[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [prompt, answer, ...wrong] = line.split("|").map((part) => part.trim());
      if (!prompt || !answer || wrong.length === 0) throw new Error(`Malformed quiz question: ${line}`);
      let options: string[];
      if ([answer, ...wrong].every((o) => NUMBER.test(o))) {
        options = [answer, ...wrong].sort((a, b) => toNumber(a) - toNumber(b));
      } else {
        options = [...wrong];
        options.splice(hash(prompt + answer) % (wrong.length + 1), 0, answer);
      }
      return { prompt, options, correctIndex: options.indexOf(answer) };
    });
}

/** Ready-to-play quizzes, so a session needs no preparation. Answers stay on the server. */
export const CURATED_QUIZZES: CuratedQuiz[] = [
  {
    id: "curated:general-knowledge",
    title: "General knowledge",
    description: "Science, history, geography, sport, culture and more.",
    questions: [
      q("How many continents are there?", ["5", "6", "7", "8"], 2),
      q("Which gas do plants absorb from the air?", ["Oxygen", "Carbon dioxide", "Nitrogen", "Helium"], 1),
      q("What is the largest ocean on Earth?", ["Atlantic", "Indian", "Arctic", "Pacific"], 3),
      q("How many sides does a hexagon have?", ["5", "6", "7", "8"], 1),
      q("Which planet is known as the Red Planet?", ["Venus", "Jupiter", "Mars", "Mercury"], 2),
      q("At what temperature does water freeze, in Celsius?", ["0°", "10°", "32°", "-10°"], 0),
      q("Who painted the Mona Lisa?", ["Michelangelo", "Leonardo da Vinci", "Raphael", "Vincent van Gogh"], 1),
      q("What is the chemical symbol for gold?", ["Go", "Gd", "Au", "Ag"], 2),
      q("How many players does a football (soccer) team have on the pitch?", ["9", "10", "11", "12"], 2),
      q("What is the smallest prime number?", ["0", "1", "2", "3"], 2),
      ...parseBank(GENERAL),
    ],
  },
  {
    id: "curated:around-africa",
    title: "Around Africa",
    description: "Capitals, history, people, food, music and more.",
    questions: [
      q("Which is the largest country in Africa by area?", ["DR Congo", "Algeria", "Sudan", "Libya"], 1),
      q("What is the capital of Kenya?", ["Mombasa", "Kampala", "Nairobi", "Dodoma"], 2),
      q("Which is the longest river in Africa?", ["Congo", "Niger", "Zambezi", "Nile"], 3),
      q("Which African country has the largest population?", ["Nigeria", "Ethiopia", "Egypt", "DR Congo"], 0),
      q("Mount Kilimanjaro is in which country?", ["Kenya", "Uganda", "Tanzania", "Rwanda"], 2),
      q("What is the capital of Ghana?", ["Kumasi", "Accra", "Lomé", "Tamale"], 1),
      q("The historic city of Timbuktu is in which country?", ["Mali", "Niger", "Senegal", "Mauritania"], 0),
      q("What is the currency of South Africa?", ["Shilling", "Pula", "Kwacha", "Rand"], 3),
      q("What is the capital of Morocco?", ["Casablanca", "Rabat", "Marrakesh", "Fes"], 1),
      q(
        "Which is the only African country with Spanish as an official language?",
        ["Equatorial Guinea", "Western Sahara", "Cape Verde", "Gabon"],
        0,
      ),
      ...parseBank(AFRICA),
    ],
  },
  {
    id: "curated:money-and-payments",
    title: "Money and payments",
    description: "Payments, banking, currencies, business and the economy.",
    questions: [
      q(
        "What does ATM stand for?",
        ["Automated Teller Machine", "Automatic Transfer Method", "Account Transaction Machine", "Any Time Money"],
        0,
      ),
      q("In which country did M-Pesa launch in 2007?", ["Tanzania", "Nigeria", "Kenya", "South Africa"], 2),
      q(
        "In banking, what does KYC stand for?",
        ["Keep Your Cash", "Know Your Customer", "Key Yield Calculation", "Know Your Card"],
        1,
      ),
      q("What is the currency code for the Nigerian naira?", ["NAI", "NGR", "NIR", "NGN"], 3),
      q("What is the currency of Ghana?", ["Cedi", "Dalasi", "Leone", "Naira"], 0),
      q(
        "In payments, what does FX stand for?",
        ["Fixed exchange", "Foreign exchange", "Fast transfer", "Fee exchange"],
        1,
      ),
      q(
        "Which card network's logo is two overlapping red and yellow circles?",
        ["Visa", "American Express", "Mastercard", "Discover"],
        2,
      ),
      q(
        "What is a chargeback?",
        [
          "A refund the merchant issues",
          "A payment reversal started by the cardholder's bank",
          "A fee for paying late",
          "A cashback reward",
        ],
        1,
      ),
      q("What does the S in HTTPS stand for?", ["Server", "Standard", "Secure", "Session"], 2),
      q(
        "The PCI DSS standard protects what?",
        ["Cardholder data", "Exchange rates", "Bank holidays", "ATM locations"],
        0,
      ),
      ...parseBank(MONEY),
    ],
  },
  {
    id: "curated:tech-and-internet",
    title: "Tech and the internet",
    description: "Computers, code, the web, gadgets and the people behind them.",
    questions: [
      q(
        "What does HTML stand for?",
        [
          "HyperText Markup Language",
          "High Transfer Machine Language",
          "Home Tool Markup Language",
          "Hyperlink Text Mode Language",
        ],
        0,
      ),
      q(
        "Who is credited with inventing the World Wide Web?",
        ["Bill Gates", "Tim Berners-Lee", "Vint Cerf", "Linus Torvalds"],
        1,
      ),
      q("Which programming language is named after a British comedy group?", ["Ruby", "Perl", "Python", "Go"], 2),
      q("How many bits are in a byte?", ["4", "8", "16", "32"], 1),
      q(
        "What does CPU stand for?",
        ["Central Processing Unit", "Computer Power Unit", "Core Program Utility", "Central Peripheral Unit"],
        0,
      ),
      q("In which year was the first iPhone released?", ["2005", "2006", "2007", "2009"], 2),
      q("Which company acquired GitHub in 2018?", ["Google", "Amazon", "Meta", "Microsoft"], 3),
      q(
        "What does URL stand for?",
        ["Universal Routing Link", "Uniform Resource Locator", "User Request Line", "Unified Remote Location"],
        1,
      ),
      q(
        "What do we call malware that locks your files until you pay?",
        ["Spyware", "Adware", "Ransomware", "A worm"],
        2,
      ),
      q("Wi-Fi sends data using what?", ["Radio waves", "Infrared light", "Sound waves", "Copper cables"], 0),
      ...parseBank(TECH),
    ],
  },
];

export interface QuizSource {
  get(id: string): Promise<CuratedQuiz | null>;
  list(): Promise<QuizSummary[]>;
}

/** Curated quizzes only. Custom, shared quizzes from the database will join this list. */
export const curatedQuizSource: QuizSource = {
  async get(id) {
    return CURATED_QUIZZES.find((quiz) => quiz.id === id) ?? null;
  },
  async list() {
    return CURATED_QUIZZES.map((quiz) => ({
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      questionCount: quiz.questions.length,
      curated: true,
    }));
  },
};
