# 📱 Scénarios de Test et Validation des Notifications d'Appel

Ce document récapitule l'ensemble des scénarios de réception d'appel avec un focus particulier sur la non-interruption lorsque le téléphone est allumé.

---

## 📋 Tableau Synthétique des Scénarios

| N° | État du Téléphone / App | Action Utilisateur | Résultat Attendu | Statut |
|---|---|---|---|---|
| **1** | **Écran Allumé / Sur une autre application** | Réception d'un appel | **Bannière flottante en haut de l'écran uniquement.** L'application en cours n'est PAS interrompue. Boutons **[Refuser]** et **[Accepter]** visibles. | ✅ Conforme |
| **2** | **Écran Allumé / Sur une autre application** | Clic sur **[Accepter]** sur la bannière | L'application s'ouvre **directement sur l'Interface 1** (avec le bouton **Bluetooth** et chronomètre). L'écran de swipe `#interface-2` est court-circuité. | ✅ Conforme |
| **3** | **Écran Allumé / Sur une autre application** | Clic sur **[Refuser]** sur la bannière | La bannière disparaît, l'appel est rejeté, **vous restez sur votre application sans être dérangé**. | ✅ Conforme |
| **4** | **Écran Allumé / Sur une autre application** | Clic sur le corps de la bannière | L'application s'ouvre sur l'écran d'appel entrant `#interface-2` (Swipe vers le haut). | ✅ Conforme |
| **5** | **Application Ouverte au 1er Plan** | Réception d'un appel | L'écran d'appel entrant interne `#interface-2` (Swipe) s'affiche directement. Pas de bannière en doublon. | ✅ Conforme |
| **6** | **Pendant l'Appel Actif (#interface-1)** | Clic sur le bouton **Bluetooth** (`#btn-toggle-audio`) | Bascule cyclique : Combiné (`EARPIECE`) ➔ Haut-parleur (`SPEAKER`) ➔ Bluetooth (`BLUETOOTH`, en vert WhatsApp). | ✅ Conforme |

---

## 🧪 Procédure de Test (Écran Allumé / Sur une autre application)

1. Ouvrez une application (YouTube, WhatsApp, Chrome, etc.) sur le téléphone destinataire.
2. Lancez un appel vers ce téléphone depuis un autre appareil.
3. **Vérification 1 :** L'application en cours (YouTube/WhatsApp) ne se ferme pas et n'est pas recouverte par l'écran plein. Une bannière flottante apparaît en haut.
4. **Vérification 2 :** 
   - Si vous cliquez sur **[Refuser]** ➔ La bannière s'efface, l'appelant reçoit l'indication de refus, vous continuez votre vidéo ou discussion.
   - Si vous cliquez sur **[Accepter]** ➔ L'application s'ouvre directement sur l'écran de communication avec le bouton Bluetooth.
