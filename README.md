# git-mod

Un mod Claude Code qui ajoute un panneau pour gérer d'un coup les branches de tous les dépôts git d'un dossier
(par exemple `/var/www`). La commande `/git-mod` ouvre le panneau.

## Ce qu'il fait

- **État des dépôts** : branche courante, commits en retard ou non poussés, modifs locales de chaque dépôt.
- **Branches par défaut** : passe chaque dépôt sur la branche par défaut annoncée par son serveur, puis récupère
  ses nouveaux commits.
- **Mettre à jour la branche courante** : pull en avance rapide dans chaque dépôt, sans changer de branche.
- **Basculer sur une branche** : passe sur une branche donnée les seuls dépôts qui l'ont, et la relie au serveur.
- **Chercher les branches fusionnées** : liste les branches locales déjà fusionnées et les supprime après
  confirmation.
- **Aligner sur le serveur** : quand une branche locale a divergé, la sauvegarde dans
  `backup/<branche>-local-<date>` puis la remet exactement sur celle du serveur, après confirmation.

## Réglages

Tout se règle dans le panneau (bouton « ⚙ Réglages ») et est gardé d'une session à l'autre :

- le dossier qui contient les dépôts, puis « Scanner » pour les trouver à tous les niveaux (sans `vendor` ni
  `node_modules`) et interroger le serveur de chacun sur sa branche par défaut ;
- pour chaque dépôt : inclus ou non, branche par défaut (corrigeable à la main), et « garder les modifs locales »
  pour un dépôt dont des fichiers versionnés sont modifiés en local (une config de dev, par exemple) : elles sont
  mises de côté puis réappliquées à chaque action, sans jamais être ajoutées à l'index ;
- la langue du panneau, français ou anglais.

## Installation

Dans une session Claude Code en terminal :

```
/plugin install git-mod --marketplace 01-Remy/git-mod
```

Depuis un shell :

```bash
claude plugin install git-mod --marketplace 01-Remy/git-mod
```

Dans l'app desktop : bouton + à côté de la zone de saisie, puis Plugins, Add marketplace avec `01-Remy/git-mod`,
puis Add plugin.

Si le dépôt est privé, l'installation ne marche que pour quelqu'un qui peut le lire sur GitHub et dont la machine
a déjà un accès git à github.com (une clé SSH, ou `gh auth login` puis `gh auth setup-git`).
