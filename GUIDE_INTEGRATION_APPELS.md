# 📖 Guide d'Intégration : Appels Entrants & Réveil d'Écran (Android 14 & 15)
> **Application :** KamSoft (`com.example.callapp`)  
> **Technologies :** Apache Cordova, Kotlin, WebRTC, Firebase Cloud Messaging (FCM)  
> **Niveau :** Débutant à Intermédiaire

---

## 🎯 1. Introduction & Objectif

Sur les anciennes versions d'Android (Android 13 et inférieur), faire sonner un téléphone et allumer l'écran lors d'un appel entrant était relativement simple : l'application recevait un message push FCM et déclenchait une notification plein écran (`FullScreenIntent`), et l'écran s'allumait automatiquement.

À partir d'**Android 14 (API 34)** et **Android 15 (API 35)**, Google a mis en place des protections strictes pour la batterie et la vie privée :
1. **L'autorisation "Notifications plein écran" est DÉSACTIVÉE par défaut** pour les applications installées hors Play Store ou non déclarées comme composeur téléphonique par défaut.
2. **Le système bloque le réveil d'activité en arrière-plan** (restrictions BAL - *Background Activity Launch*).
3. **Le mode Doze (sommeil profond)** coupe l'alimentation de l'écran même en cas de notification.

Ce guide explique comment notre solution résout ces 3 problèmes pour que votre application se comporte **comme un véritable appel téléphonique (WhatsApp / Téléphone classique)**.

---

## 🧱 2. Les Plugins Utilisés

| Plugin | Rôle dans l'application | Pourquoi il est indispensable |
| :--- | :--- | :--- |
| **`@havesource/cordova-plugin-push`** | Réception des notifications FCM et affichage de l'interface d'appel natif. | C'est le cœur du système. Il intercepte le message du serveur même si l'app est fermée, allume l'écran et affiche la bannière ou le plein écran. |
| **`cordova-plugin-background-mode`** | Maintien de l'application en tâche de fond. | Empêche le système de tuer la WebView pendant une communication active. |
| **`cordova-plugin-insomnia`** | Contrôle du rétroéclairage de l'écran. | Maintient l'écran allumé pendant toute la durée de la conversation. |
| **`cordova-plugin-audiotoggle`** | Routage du flux audio. | Permet de basculer le son entre le combiné à l'oreille (`EARPIECE`), le haut-parleur (`SPEAKER`) et le Bluetooth (`BLUETOOTH`). |

---

## 📂 3. Cartographie des Fichiers Modifiés

Voici l'ensemble des fichiers qui ont été adaptés pour rendre les appels 100% compatibles Android 14/15 :

```text
📁 A MERVEILLE/
├── 📁 plugins/@havesource/cordova-plugin-push/     ⬅️ SOURCE DE RÉFÉRENCE (À conserver !)
│   ├── 📁 src/android/com/adobe/phonegap/push/
│   │   ├── 📄 FCMService.kt                       (WakeLock matériel + Intent plein écran)
│   │   ├── 📄 PushPlugin.kt                       (Nouvelles méthodes check / open settings)
│   │   ├── 📄 BackgroundActionButtonHandler.kt    (Libération du WakeLock au clic Accepter/Refuser)
│   │   ├── 📄 PushDismissedHandler.kt             (Libération du WakeLock au balayage de notif)
│   │   └── 📄 PushHandlerActivity.kt              (Libération du WakeLock au tap sur la notif)
│   └── 📁 www/
│       └── 📄 push.js                             (Pont JS pour appeler les fonctions natives)
│
├── 📁 www/js/                                     ⬅️ CODE DE VOTRE APPLICATION
│   ├── 📄 CallManager.js                          (Détection Android 14+, affichage de la modale d'alerte)
│   └── 📄 index.js                                (Ré-évaluation de la permission au retour des réglages)
│
└── 📄 config.xml                                  (Déclaration des permissions Android)
```

---

## ⚙️ 4. Explication des Modifications (Étape par Étape)

### Étape A : Le Réveil Matériel de l'Écran (WakeLock) dans `FCMService.kt`
* **Problème résolu :** Même si Android reçoit l'appel, la dalle de l'écran reste noire si le processeur dort (Doze mode).
* **Ce qui a été fait :**
  Lorsqu'un appel entrant arrive (`shouldTriggerFullScreen == true`), le code Kotlin demande un réveil matériel immédiat au système :
  ```kotlin
  val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
  val wakeLock = powerManager.newWakeLock(
      PowerManager.FULL_WAKE_LOCK or
      PowerManager.ACQUIRE_CAUSES_WAKEUP or
      PowerManager.ON_AFTER_RELEASE,
      "KamSoft:IncomingCallWakeLock"
  )
  wakeLock.acquire(10000) // Allume physiquement l'écran (max 10 secondes de sécurité)
  ```
* **Anti-fuite de batterie :** Dès que l'utilisateur clique sur *Accepter*, *Refuser*, ou que l'appel est annulé à distance, la méthode `FCMService.releaseCallWakeLock()` coupe immédiatement ce verrou.

---

### Étape B : L'Intent Plein Écran Normalisé dans `FCMService.kt`
* **Ce qui a été fait :**
  L'Activity de l'application est ciblée avec les drapeaux exacts requis par Android pour s'afficher par-dessus l'écran de verrouillage sans être bloquée :
  ```kotlin
  val fullScreenIntent = Intent(context, com.example.callapp.MainActivity::class.java).apply {
      action = Intent.ACTION_MAIN
      addCategory(Intent.CATEGORY_LAUNCHER)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra(PushConstants.PUSH_BUNDLE, extras)
  }
  mBuilder.setFullScreenIntent(fullScreenPendingIntent, true)
  mBuilder.setCategory(NotificationCompat.CATEGORY_CALL)
  mBuilder.setPriority(NotificationCompat.PRIORITY_MAX)
  ```

---

### Étape C : Vérification de l'Autorisation Android 14+ dans `PushPlugin.kt`
* **Problème résolu :** Savoir depuis le JavaScript si l'utilisateur a autorisé l'affichage plein écran ou non.
* **Nouvelles fonctions créées :**
  1. `checkFullScreenIntentPermission` : Interroge l'API Android 14 `notificationManager.canUseFullScreenIntent()`. Renvoie `true` ou `false`.
  2. `openFullScreenIntentSettings` : Ouvre automatiquement la page exacte des paramètres Android de l'application pour que l'utilisateur n'ait qu'à basculer l'interrupteur.

---

### Étape D : L'Expérience Utilisateur (UI) dans `CallManager.js` & `index.js`
* **Ce qui a été fait :**
  1. Au lancement de l'application (`initApp`), `callManager.verifyFullScreenIntentPermission()` s'exécute silencieusement.
  2. Si l'appareil tourne sous Android 14/15 et que la permission est **désactivée**, une modale moderne et soignée apparaît :
     * Elle explique clairement la situation à l'utilisateur.
     * Le bouton **[⚙️ Ouvrir les Paramètres]** emmène directement au réglage Android requis.
  3. Dès que l'utilisateur active l'option et appuie sur la flèche retour pour revenir dans l'application, l'événement `resume` (dans `index.js`) revérifie automatiquement le statut et **fait disparaître la modale sans rechargement**.

---

## 🚀 5. Guide Pratique pour Compiler et Tester

Si vous êtes débutant avec Cordova, voici les commandes indispensables à connaître pour compiler votre projet sans mauvaises surprises.

### 1. Synchroniser vos modifications vers le dossier Android
À chaque fois que vous modifiez un fichier dans `www/` ou dans `plugins/`, exécutez dans le terminal :
```bash
cordova prepare android
```
Cette commande met à jour automatiquement le dossier de compilation Android (`platforms/android/`).

### 2. Régénération propre (si nécessaire)
Si vous constatez qu'un ancien fichier Kotlin refuse de se mettre à jour dans `platforms/`, vous pouvez réinitialiser la plateforme en 2 commandes simples :
```bash
cordova platform rm android
cordova platform add android
```
*(Grâce aux modifications faites dans `plugins/`, tout se régénérera parfaitement à l'identique).*

### 3. Tester sur votre téléphone Android 14 ou 15
1. Installez l'application sur votre téléphone (via Android Studio ou `cordova run android`).
2. À la première ouverture, la modale d'alerte va s'afficher :
   - Cliquez sur **[⚙️ Ouvrir les Paramètres]**.
   - Activez l'option **"Autoriser les notifications plein écran"**.
   - Revenez en arrière : la boîte de dialogue disparaît automatiquement.
3. **Le grand test en veille :**
   - Verrouillez complètement votre téléphone (écran éteint, noir).
   - Depuis un autre appareil ou depuis votre serveur, lancez un appel vers cet ID.
   - **Résultat attendu :** L'écran s'allume immédiatement et affiche l'interface d'appel par-dessus l'écran de verrouillage, avec sonnerie et vibration !

---

## 🛡️ 6. Bonnes Pratiques & Précautions pour le Futur

1. **Ne modifiez jamais directement les fichiers dans `platforms/`** :
   Le dossier `platforms/` est un dossier généré. Vos vrais fichiers de travail sont dans `www/` (pour le web) et dans `plugins/` (pour le code natif).
2. **Identifiant de paquet (`com.example.callapp`)** :
   Pensez avant la publication sur le Google Play Store à remplacer `com.example.callapp` dans `config.xml` par votre identifiant officiel (ex: `com.kamsoft.call`).
3. **Surveillez les logs avec `adb logcat`** :
   Pour voir ce qui se passe en temps réel lors de la réception d'un push, lancez dans votre terminal :
   ```bash
   adb logcat -s "PushPlugin" "FCMService"
   ```
   Vous verrez distinctement l'allumage de l'écran et l'état des autorisations grâce aux balises `[CALL_DEBUG]` et `[WakeLock]`.
