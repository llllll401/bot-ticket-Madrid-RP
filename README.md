# Bot de tickets Discord • Madrid RP

Un bot de tickets en français pour **un seul serveur Discord**, configurable par son ID. Les membres ouvrent un salon privé depuis un menu ; l’équipe suit le dossier avec des boutons et voit son statut directement dans le nom du salon.

> **Attention : fermer un ticket supprime définitivement son salon et tous ses messages après confirmation. Aucune transcription automatique n’est créée.**

## Types de tickets

- Plainte
- Question
- RC STAFF
- Demande UNBAN
- Fondation
- Partenariat

Chaque membre peut avoir **un ticket ouvert par type** à la fois. Il peut donc ouvrir une question et une plainte en même temps. Le bot retrouve ses tickets et ses boutons après un redémarrage si son fichier de données est conservé.

## Statuts et couleurs

Discord ne permet pas de colorer directement le texte des noms de salons : le bot utilise donc des **ronds colorés** dans les noms.

| Couleur | Statut | Exemple de nom |
| --- | --- | --- |
| 🔴 | En attente | `🔴-attente-plainte-joueur-0001` |
| 🟠 | Pris en charge | `🟠-pris-en-charge-plainte-joueur-0001` |
| 🟡 | En cours de… | `🟡-en-cours-de-verification-plainte-joueur-0001` |
| 🟢 | Traité | `🟢-traite-plainte-joueur-0001` |
| ⚫ | Ancien ticket fermé avant la mise à jour | `⚫-ferme-plainte-joueur-0001` |

Les nouvelles fermetures suppriment le salon : elles ne produisent donc pas de nom noir. Le numéro reste identique tout au long du ticket. Pour « En cours de… », un formulaire permet au staff d’indiquer une étape courte (par exemple `vérification` ou `enquête`). Choisissez un libellé non sensible : il apparaît dans le nom du salon.

**Limite Discord :** les renommages de salons sont limités et peuvent être retardés plusieurs minutes. Pour ne pas bloquer le traitement, les boutons et les permissions sont mis à jour immédiatement, tandis que le nom est synchronisé en arrière-plan avec le dernier statut. Pendant ce délai, le nom peut donc afficher l’ancien statut : le panneau du ticket indique alors `⏳` et reste la référence à jour. Laissez le bot en ligne ; il retente automatiquement et reprend les renommages en attente après un redémarrage. Voir les [limites de l’API Discord](https://docs.discord.com/developers/topics/rate-limits).

## Mise en place

### 1. Préparer Discord

1. Créez une application et un bot dans le [Discord Developer Portal](https://discord.com/developers/applications). Récupérez **le token du bot** et l’**ID de l’application**. Le token est un secret : ne le publiez pas et ne l’envoyez à personne.
2. Invitez le bot sur le serveur souhaité, avec les scopes `bot` et `applications.commands`. Pour les permissions utilisées par ce projet, remplacez `ID_APPLICATION` dans ce lien :

   ```text
   https://discord.com/oauth2/authorize?client_id=ID_APPLICATION&permissions=378225675280&scope=bot%20applications.commands
   ```

   Le bot a besoin de voir et gérer les salons, gérer les permissions des rôles/membres, envoyer des messages, intégrer des liens, joindre des fichiers, lire l’historique et gérer les droits d’écriture dans les fils. **`Gérer les salons` est indispensable pour supprimer un ticket**, y compris dans le salon concerné. `Gérer les rôles` est une permission sensible : utilisez un bot dédié et vérifiez sa position dans la hiérarchie des rôles. Les restrictions propres à un salon ou à une catégorie doivent aussi laisser le bot travailler.
3. Activez le **mode développeur** dans les paramètres Discord, puis copiez l’ID du serveur, les IDs des rôles de l’équipe et les IDs des six catégories Discord où créer les tickets. Ces catégories doivent déjà exister sur le serveur. Le rôle `@everyone` ne peut pas être utilisé comme rôle staff.
4. Les intents privilégiés ne sont pas nécessaires : ne les activez pas pour ce bot.

### 2. Installer et configurer

Prérequis : **Node.js 20 ou plus récent** et npm. Dans le dossier du projet :

```bash
npm ci
```

Toute la configuration se trouve dans **`config.json`**. S’il n’existe pas encore, créez-le à partir du modèle :

```bash
cp config.example.json config.json
```

Sous Windows, utilisez `Copy-Item config.example.json config.json` dans PowerShell. Ne recopiez pas le modèle si vous avez déjà rempli votre `config.json`, car cela écraserait vos réglages.

Ouvrez `config.json` et remplacez les champs vides :

```json
{
  "token": "TOKEN_DU_BOT",
  "serveurId": "ID_DU_SERVEUR",
  "rolesStaff": ["ID_DU_ROLE_STAFF"],
  "categories": {
    "plainte": "ID_CATEGORIE_PLAINTE",
    "question": "ID_CATEGORIE_QUESTION",
    "rc_staff": "ID_CATEGORIE_RC_STAFF",
    "demande_unban": "ID_CATEGORIE_DEMANDE_UNBAN",
    "fondation": "ID_CATEGORIE_FONDATION",
    "partenariat": "ID_CATEGORIE_PARTENARIAT"
  },
  "rolesStaffParCategorie": {
    "plainte": [],
    "question": [],
    "rc_staff": [],
    "demande_unban": [],
    "fondation": [],
    "partenariat": []
  },
  "fichierDonnees": "./data/tickets.json"
}
```

- `token` et `serveurId` : le token du bot et l’ID du **seul** serveur autorisé.
- `rolesStaff` : au moins un ID de rôle staff. Vous pouvez mettre plusieurs rôles : `["ID_ROLE_1", "ID_ROLE_2"]`.
- `categories` : renseignez **les six IDs de catégories Discord**, un pour chaque type. Il n’y a pas de catégorie par défaut et aucun ticket n’est créé à la racine. Vous pouvez répéter un ID si plusieurs types doivent partager une catégorie. Une modification d’ID concerne les **nouveaux** tickets ; les salons existants ne sont pas déplacés.
- `rolesStaffParCategorie` : facultatif. Une liste vide utilise `rolesStaff` ; une liste non vide **remplace** les rôles généraux pour ce type, par exemple `"plainte": ["ID_ROLE_RESPONSABLE"]`. C’est utile pour restreindre les plaintes ou les tickets RC STAFF. Après modification, redémarrez le bot : il retire les anciens accès qu’il avait accordés et applique les nouveaux aux tickets existants avant de traiter les interactions. Les accès ajoutés manuellement ne sont pas supprimés.
- `fichierDonnees` : emplacement du registre local, relatif au dossier de `config.json` (par défaut `./data/tickets.json`).

Les IDs Discord doivent être des **chaînes entre guillemets** : ils sont trop grands pour être conservés précisément comme nombres JSON. Remplacez les textes de l’exemple par les vrais IDs numériques, sans `@` ni chevrons.

Le fichier `config.json`, qui contient le token, et le dossier `data/` sont ignorés par Git. Gardez `config.json` privé et ne le partagez pas ; si le token a été exposé, régénérez-le dans le Developer Portal. Si vous choisissez un autre chemin pour les données, excluez-le également de Git et vérifiez qu’il est accessible en écriture.

### 3. Démarrer et publier le panneau

```bash
npm start
```

Laissez le processus en fonctionnement sur une machine ou un hébergement disponible en permanence : le bot ne répond pas quand il est arrêté. Au démarrage, il vérifie le serveur, les rôles, les catégories et ses permissions, puis enregistre ses commandes **uniquement sur ce serveur**. Il ignore les interactions provenant d’un autre serveur ou des messages privés, même s’il a été invité ailleurs.

Dans le salon où les membres doivent ouvrir leurs tickets, une personne ayant la permission **Gérer le serveur** lance :

```text
/panneau-tickets
```

Un menu public avec les six types apparaît. Le salon du panneau doit être visible des membres ; le bot doit pouvoir y envoyer des messages et des embeds. La réponse de création et les confirmations sont privées.

## Utilisation au quotidien

1. Le membre choisit un type dans le menu et décrit sa demande dans le salon créé. Le bot mentionne les rôles concernés ; pour qu’une mention de rôle déclenche une notification, le rôle doit être mentionnable ou les réglages Discord doivent l’autoriser.
2. Le staff autorisé clique sur **Gérer le dossier**. Un menu privé regroupe les actions : prendre ou reprendre, indiquer une étape, marquer traité, remettre en attente, modifier la priorité, changer de catégorie, ajouter ou lire les notes internes et contacter un rôle. Les anciens boutons correspondants ne sont plus affichés ; les anciennes interactions continuent d’être prises en charge. `/ticket-prendre` reste disponible, mais n’est pas nécessaire.
3. Si le ticket a déjà un autre responsable, une confirmation privée est demandée avant de le reprendre ; si la responsabilité a changé entre-temps, il faut recommencer. **En cours de…** précise l’étape et **Marquer traité** passe le ticket au vert ; sans responsable, ces actions l’attribuent à la personne qui les utilise. **Remettre en attente** enlève le responsable et l’étape. La priorité urgente ou normale apparaît sur le panneau du salon, visible par le créateur, et dans `/tickets`, sans changer l’ancienneté.
4. Le créateur ou le staff peut cliquer sur **Fermer** ou lancer **`/ticket-fermer`** dans le salon, puis confirmer. Cela **supprime définitivement le salon et tous ses messages**, sans transcription automatique ; le ticket ne peut pas être rouvert. Les notes internes du registre sont également effacées. Le membre peut ensuite ouvrir un nouveau ticket du même type. **Marquer traité ne ferme pas automatiquement** : le ticket reste ouvert jusqu’à sa fermeture explicite.

### Actions du dossier

- **Changer la catégorie** : choisissez l’un des six types, puis confirmez. Le salon est déplacé dans la catégorie Discord configurée pour ce type, sans hériter automatiquement des permissions de la catégorie. Les anciens rôles staff gérés par le bot sont remplacés par ceux du nouveau type. Le ticket est remis en attente et son responsable est libéré ; la priorité est conservée. Si le membre possède déjà un ticket ouvert dans le type choisi, le déplacement est refusé. Vous pouvez perdre l’accès si vous n’appartenez pas à la nouvelle équipe. **Les accès ajoutés manuellement à d’autres rôles ou membres restent en place** : vérifiez-les particulièrement pour un dossier sensible. Les notes internes deviennent consultables par l’équipe autorisée pour le nouveau type.
- **Ajouter / consulter les notes internes** : elles sont enregistrées localement avec leur auteur et leur date, jamais envoyées dans le salon du membre. Leur consultation est éphémère et réservée aux rôles staff du type courant et aux administrateurs qui peuvent voir le salon ; les droits sont revérifiés au moment de l’action. Limite : 100 notes de 800 caractères par ticket. Toute personne ayant accès au fichier de données ou à ses sauvegardes peut aussi les lire.
- **Contacter un rôle** : choisissez un rôle puis écrivez un message de 600 caractères maximum. Il est publié **dans le ticket**, donc visible par le créateur ; seul le rôle choisi peut être notifié, même si le texte contient d’autres mentions. `@everyone` est refusé. Une mention ne donne **pas** accès au salon : les membres du rôle doivent déjà pouvoir le voir. Pour que Discord accepte la notification, le rôle doit être mentionnable ou le bot doit avoir la permission de mentionner les rôles dans ce salon ; les préférences individuelles de notification restent gérées par Discord.

### Anciens tickets fermés

Les salons déjà fermés en lecture seule **avant cette mise à jour sont conservés** : le bot ne les supprime pas automatiquement. Leurs panneaux sont adaptés pour que le staff puisse soit les **Rouvrir** (en restaurant les droits d’écriture enregistrés et en les remettant en attente), soit **Supprimer le salon** après confirmation. Pour rouvrir, aucun autre ticket du même type ne doit être ouvert par ce membre. Les anciennes confirmations de fermeture, qui promettaient une simple lecture seule, sont refusées : relancez la fermeture pour voir le nouvel avertissement.

Le **menu public** publié avant la mise à jour n’est pas remplacé automatiquement. Pour actualiser sa légende, relancez `/panneau-tickets` dans son salon, puis supprimez vous-même l’ancien message si vous le souhaitez. L’ancien menu continue néanmoins à ouvrir des tickets.

Les boutons de gestion sont réservés aux rôles configurés pour le type concerné et aux administrateurs. La prise en charge indique un responsable mais **ne retire pas l’accès aux autres membres du staff autorisés**. Le créateur ne peut que fermer son propre ticket. Les tickets sont privés pour `@everyone` et ouverts explicitement au créateur, aux rôles concernés et au bot. **Les administrateurs Discord contournent les restrictions de salons**, et les personnes pouvant modifier les permissions du serveur peuvent aussi changer l’accès : vérifiez vos rôles pour les demandes sensibles.

### Suivi de plusieurs tickets

Le staff peut lancer **`/tickets`** depuis un salon où les commandes sont autorisées. La réponse est personnelle et éphémère ; elle affiche par défaut les tickets ouverts : les **urgents d’abord**, puis les statuts en commençant par les attentes les plus anciennes. Pour un ticket remis en attente ou rouvert, l’ancienneté repart de ce changement de statut. Les boutons permettent de changer de page, d’actualiser ou de filtrer rapidement les **urgents** et les tickets **sans responsable** ; les deux filtres peuvent être combinés.

Options disponibles dans la commande :

- `statut` : en attente, pris en charge, en cours, traité, anciens fermés, tous les ouverts ou les ouverts et anciens fermés ;
- `categorie` : l’un des six types de tickets ;
- `responsable` : les tickets attribués à la personne choisie ;
- `mes_tickets` : uniquement les tickets attribués à la personne qui utilise la commande, et non ceux qu’elle a créés ; ne combinez pas ce filtre avec un responsable différent ;
- `sans_responsable` : uniquement les tickets non attribués ; ne combinez pas ce filtre avec `responsable` ou `mes_tickets` ;
- `priorite` : urgente ou normale. Les anciens tickets sans priorité enregistrée sont considérés comme normaux.

Les compteurs indiquent les tickets **visibles**, par statut, après application des filtres catégorie, responsable et priorité ; ils incluent les anciens fermés même si la liste est filtrée sur les tickets ouverts. La vue ne montre ni les salons manquants ou supprimés, ni les tickets d’un type non autorisé, ni ceux dont la personne ne peut pas voir le salon. Ces droits sont revérifiés à chaque page, actualisation et filtre rapide. Si les droits changent après l’affichage, actualisez : une information déjà affichée ne peut pas être retirée de la mémoire ou des captures d’écran du destinataire. Si le tableau a expiré, relancez `/tickets`.

### Réparation

Au démarrage, les anciens panneaux de tickets sont mis à jour en arrière-plan, sans nouvelle mention des rôles. Si un panneau ne peut pas être modifié, le bot passe au suivant ; il retentera au prochain démarrage.

Si le panneau de gestion d’un ticket a été supprimé ou si son nom a été modifié manuellement, un membre du staff peut lancer **`/ticket-panneau` dans ce ticket** pour le rétablir. Le nom est alors resynchronisé dès que Discord le permet. Les salons supprimés manuellement sont aussi reconnus comme tels, afin de ne pas empêcher une nouvelle demande.

> **Demande UNBAN :** une personne bannie du serveur Discord ne peut pas voir son panneau ni y ouvrir un ticket. Ce type fonctionne pour les personnes qui ont encore accès au Discord (par exemple pour un bannissement en jeu). Pour les bannissements Discord, prévoyez un moyen de recours externe.

## Données et exploitation

Le registre `data/tickets.json` contient les IDs, les statuts, les priorités, les responsables, les **notes internes rédigées par le staff** et les informations nécessaires au suivi. Le bot ne copie pas automatiquement le contenu des messages du ticket. Les notes sont stockées en clair dans le fichier local, protégé au mieux par ses permissions système (mode `600` sur les systèmes compatibles), et non par un chiffrement : protégez le stockage et ses sauvegardes. Quand le bot constate la suppression du salon, les notes sont effacées du registre courant, mais peuvent subsister dans d’anciennes sauvegardes. Si le salon est supprimé manuellement pendant l’arrêt du bot, une vérification en arrière-plan au redémarrage le détecte et purge ses notes ; en cas d’erreur Discord, consultez les journaux et réessayez. Lors d’une fermeture ou d’une suppression confirmée, le registre conserve aussi l’ID de la personne qui l’a demandée et la date de demande. Les autres métadonnées restent après suppression : définissez une politique de conservation adaptée. Le fichier est écrit de manière atomique et lié à l’ID du serveur. Conservez-le sur un stockage persistant et sauvegardez-le régulièrement ; ne le supprimez pas lors d’une mise à jour ou d’un redéploiement. Si vous changez de serveur, utilisez un autre fichier de données. Un fichier invalide ou lié à un autre serveur bloque le démarrage au lieu d’être écrasé.

Si la suppression est interrompue ou que sa réponse est incertaine, le bot vérifie au redémarrage : si le salon a disparu, il finalise le registre ; s’il existe encore, il **ne le supprime pas automatiquement** et une nouvelle confirmation est nécessaire. Si Discord ne permet pas de vérifier, le journal est conservé et l’initialisation peut être arrêtée jusqu’à résolution du problème. Une suppression refusée laisse le ticket ouvert : vérifiez les permissions puis réessayez.

Si un changement de catégorie est interrompu, les droits du salon peuvent avoir été partiellement modifiés. Les deux types restent réservés pour éviter les doublons et les autres actions de gestion sont bloquées. Un administrateur doit vérifier les accès, corriger la cause (permissions, catégorie pleine ou Discord indisponible), puis redémarrer le bot : celui-ci reprend le changement confirmé avec la configuration actuelle. Si la reprise échoue, il bloque son démarrage sans effacer le journal. Le créateur peut toujours fermer le ticket si le salon reste accessible.

Ne lancez **qu’une seule instance** du bot pour ce registre : le stockage local n’est pas partagé entre processus. Les salons des anciens tickets fermés sont conservés jusqu’à une suppression explicite. Vérifiez les besoins de conservation et prévenez les personnes concernées avant toute suppression ; le bot n’archive ni ne diffuse les conversations.

Discord limite actuellement une catégorie à **50 salons** et un serveur à **500 salons**, toutes utilisations confondues. Les anciens tickets fermés conservés et les autres salons occupent aussi ces places. Si Discord refuse une création parce que la catégorie ou le serveur est plein, le membre reçoit une explication et le bot ne crée pas le ticket ailleurs. Libérez de la place, ou modifiez l’ID explicite du type dans `config.json` pour les futurs tickets puis redémarrez ; les tickets existants ne sont pas déplacés. Les plafonds Discord peuvent évoluer : consultez les [limites Discord](https://support.discord.com/hc/en-us/articles/33694251638295-Discord-Account-Caps-Server-Caps-and-More).

### Vérifier le projet

```bash
npm test
```

Les tests utilisent des simulations et ne nécessitent pas de token. Un essai réel sur votre serveur reste nécessaire pour vérifier les permissions et l’affichage Discord.

En cas de problème, consultez les journaux de démarrage, vérifiez l’ID du serveur, les IDs des rôles/catégories, les permissions du bot et les restrictions du salon. Si un changement de rôles échoue au démarrage, corrigez les permissions, vérifiez les accès des tickets concernés, puis redémarrez : la synchronisation sera retentée.
