const cheerio = require("cheerio");
const axios = require("axios");
const fs = require("fs");
const Syno = require("syno");
const userAgent = require("user-agents");
const puppeteer = require("puppeteer-extra");

const RecaptchaPlugin = require("puppeteer-extra-plugin-recaptcha");

puppeteer.use(
  RecaptchaPlugin({
    provider: { id: "2captcha", token: process.env.TWOCAPTCHA_TOKEN },
    visualFeedback: true,
  })
);

var syno = new Syno({
  protocol: process.env.SYNO_PROTOCOL,
  host: process.env.SYNO_HOST,
  port: process.env.SYNO_PORT,
  account: process.env.SYNO_ACCOUNT,
  passwd: process.env.SYNO_PASSWORD,
});

const storageFilePath = "./db.json";

runScript();
setInterval(runScript, 1000 * 60 * process.env.REFRESH_RATE);

async function runScript() {
  log("Démarrage du traitement...");
  let response = null;
  try {
    response = await axios.get(process.env.MOVIE_LIST_URL);
  } catch (err) {
    log(`Erreur pendant la récupération de la page des films: ${err.message}`);
    log(`Attente de la prochaine execution...`);
    return;
  }

  const extractedMovies = extractMoviesFromPage(response.data);

  let tasks = getDownloadTasks();

  addMoviesToTasks(tasks, extractedMovies);

  persistDownloadTasks(tasks);

  const moviesToDownload = filterGoodMovies(getNotDownloadedTasks(tasks));

  await scrapDownloadLinks(moviesToDownload);

  log(`Traitement terminé`);

  persistDownloadTasks(tasks);

  log("Liste des tâches enregistrée");
}

async function downloadPromise(args) {
  const movie = args.movie;
  const page = args.page;
  try {
    log(`----------------- ${movie.name} -----------------`);

    log(`Tentative de récupération du lien DLproject pour Uptobox`, movie);

    const response = await axios.get(movie.page_link);
    const $ = cheerio.load(response.data);
    const dlproject_link = $("strong.hebergeur:contains(Uptobox)")
      .closest("a")
      .attr("href");

    if (!dlproject_link) {
      log("Pas de lien Uptobox", movie);
      throw "Pas de lien Uptobox";
    }

    log(`Lien DLProject pour uptobox trouvé"`, movie);

    movie.dlproject_link = dlproject_link;

    log(`Tentative de récupération du lien Uptobox sur DLProject"`, movie);

    await page.setUserAgent(userAgent.toString());
    await page.goto(movie.dlproject_link);

    await page.waitForSelector("#submit_button");
    await page.click("#submit_button");
    log(`Résolution du Recaptcha en cours...`, movie);

    const { error } = await page.solveRecaptchas();

    if (error) {
      log(`Résolution du Recaptcha échouée, nouvelle tentative...`, movie);
      const { error } = await page.solveRecaptchas();
      if (error) {
        log(`Deuxième tentative échouée`, movie);
        throw "Résolution du Recaptcha échouée malgrès 2 tentatives";
      }
    }

    log(`Recaptcha résolu, récupération des liens...`, movie);

    await page.waitForSelector(".affichier_lien");

    const downloadLinks = await page.evaluate(
      "$('.affichier_lien a').map( function() { return $(this).attr('href');}).get();"
    );

    if (downloadLinks.length < 1) {
      log(`Aucun lien Uptobox trouvé sur DLProject`, "movie");
      throw "Aucun lien Uptobox trouvé sur DLProject";
    }

    log(`Liens uptobox récupérés avec succès: ${downloadLinks.join(", ")}`);

    movie.download_links = downloadLinks;

    log("Envoi des liens à Download Station...", movie);

    await sendDownloadTaskToDownloadStation(movie.download_links);

    movie.downloaded = true;
  } catch (err) {
    log(err, movie);
    movie.excluded = true;
  }
}

async function mapSeries(iterable, action) {
  for (const x of iterable) {
    await action(x);
    persistDownloadTasks(tasks);
  }
}

function getNotDownloadedTasks(tasks) {
  const notDownloadedTasks = {};
  Object.keys(tasks).forEach((key) => {
    const task = tasks[key];
    if (!task.excluded && !task.downloaded) {
      notDownloadedTasks[task.name] = task;
    }
  });
  return notDownloadedTasks;
}

function addMoviesToTasks(storedMovies, goodMovies) {
  Object.keys(goodMovies).forEach((key) => {
    const goodMovie = goodMovies[key];

    if (!storedMovies.hasOwnProperty(goodMovie.name)) {
      storedMovies[goodMovie.name] = goodMovie;
      log(
        `Film "${goodMovie.name}" ajouté au tâches de téléchargement possibles`
      );
    }
  });
}

function persistDownloadTasks(tasks) {
  fs.writeFileSync(storageFilePath, JSON.stringify(tasks));
}

function getDownloadTasks() {
  let tasks = {};
  if (fs.existsSync(storageFilePath)) {
    try {
      tasks = JSON.parse(fs.readFileSync(storageFilePath));
    } catch (e) {
      tasks = {};
    }
    return tasks;
  } else {
    return tasks;
  }
}

function filterGoodMovies(movies) {
  const goodMovies = {};
  Object.keys(movies).forEach((key) => {
    const movie = movies[key];

    if (parseFloat(movie.rating) >= parseFloat(process.env.MIN_RATING)) {
      log(
        `Le film ${movie.name} va être téléchargé car sa note IMDB est de ${movie.rating} >= ${process.env.MIN_RATING}`
      );
      goodMovies[key] = movie;
    }
  });
  return goodMovies;
}

async function scrapDownloadLinks(moviesToDownload) {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  await mapSeries(
    Object.keys(moviesToDownload).map((k) => {
      return { page, movie: moviesToDownload[k] };
    }),
    downloadPromise
  );

  browser.close();
}

function extractMoviesFromPage(html) {
  const $ = cheerio.load(html);
  const extractedMovies = {};
  $(".top-last").each((index, $movie) => {
    const movie = {};
    movie.name = $($movie).find(".top-title").text();
    movie.rating = parseFloat($($movie).find(".imdbRating").text());
    movie.page_link = $($movie).attr("href");
    movie.downloaded = false;
    movie.excluded = false;
    movie.logs = [];
    extractedMovies[movie.name] = movie;
  });
  return extractedMovies;
}

function log(message, movie) {
  console.log(new Date(), " | ", message);
  if (movie) {
    movie.logs.push(new Date() + " | " + message);
  }
}

function sendDownloadTaskToDownloadStation(urls) {
  return new Promise((resolve, reject) => {
    syno.dl.createTask({ uri: urls.join(",") }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
