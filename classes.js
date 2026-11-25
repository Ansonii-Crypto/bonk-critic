// Set video to a local path (e.g. './videos/weaver.mp4') when a clip is ready.
const PLAYER_CLASSES = [
  {id:'weaver',name:'Weaver',summary:"Uses close control and changes of direction to get around opponents.",attack:"Keeps the ball close and works around challenges to find space.",defence:"Moves around the opponent to get a touch on the ball and take possession.",example:"Look for changes of direction that let the player keep the ball through a challenge.",video:'',videoType:'video/mp4'},
  {id:'bulwark',name:'Bulwark',summary:"Holds their ground and uses positioning to protect the ball or block a route.",attack:"Shields the ball and gives teammates time to get into position.",defence:"Stays between the opponent and a dangerous area, making it harder to get through.",example:"Look at where the player holds their position and which route that blocks.",video:'',videoType:'video/mp4'},
  {id:'catalyst',name:'Catalyst',summary:"Starts moves and puts opponents under pressure to make something happen.",attack:"Starts passing moves or draws an opponent out to open space for a teammate.",defence:"Closes down the ball carrier and forces them to make a quick decision.",example:"Look for the pass or challenge that gets the move going.",video:'',videoType:'video/mp4'},
  {id:'tactician',name:'Tactician',summary:"Reads the play and gets into position before the next touch.",attack:"Moves early to receive a pass or set up the next touch.",defence:"Spots where the ball is likely to go and gets there to cut it off.",example:"Look at where the player is before the ball reaches them.",video:'',videoType:'video/mp4'},
  {id:'opportunist',name:'Opportunist',summary:"Makes the most of loose balls, mistakes, and gaps that only last a moment.",attack:"Gets a shot or touch away when a gap opens or the ball breaks loose.",defence:"Takes the ball when an opponent leaves it exposed or commits too far.",example:"Look for the opening and how quickly the player takes it.",video:'',videoType:'video/mp4'},
  {id:'dynamo',name:'Dynamo',summary:"Keeps moving and stays involved from one challenge to the next.",attack:"Offers passing options and follows up after the first shot or pass.",defence:"Gets back quickly and challenges again if the first attempt fails.",example:"Follow the player after their first touch or challenge to see how they get involved again.",video:'',videoType:'video/mp4'},
  {id:'renegade',name:'Renegade',summary:"Takes unexpected approaches and makes their own openings. Hard to predict, even when playing patiently.",attack:"Uses unusual touches, sudden turns, or an unexpected route to catch opponents out. May hold the ball and wait before trying something different.",defence:"Challenges from an unexpected angle or steps in when most players would retreat. Changes their approach to keep the opponent guessing.",detail:"Unpredictable decisions define this class, not constant aggression. Their improvisation can catch teammates off guard too.",example:"Look for a decision that breaks the expected pattern, rather than just a fast or forceful play.",video:'',videoType:'video/mp4'}
];

const CLASS_MATCHUPS = [
    { strong: 'Weaver', weak: 'Bulwark', reason: 'Close control and direction changes let Weaver work around the route Bulwark is holding.' },
    { strong: 'Bulwark', weak: 'Catalyst', reason: 'Bulwark holds position through the first challenge and makes Catalyst commit.' },
    { strong: 'Bulwark', weak: 'Opportunist', reason: 'Bulwark shields loose balls and closes the quickest route to goal.' },
    { strong: 'Catalyst', weak: 'Tactician', reason: 'Catalyst starts the challenge early and forces Tactician to react before they can settle into position.' },
    { strong: 'Tactician', weak: 'Renegade', reason: 'Tactician covers where an unexpected touch could send the ball.' },
    { strong: 'Tactician', weak: 'Opportunist', reason: 'Tactician spots the open lane or likely rebound early and gets there first.' },
    { strong: 'Opportunist', weak: 'Dynamo', reason: 'Opportunist times a run into the space Dynamo leaves when chasing the ball or rejoining the attack.' },
    { strong: 'Dynamo', weak: 'Catalyst', reason: 'Dynamo recovers quickly after the first challenge and contests the second ball.' },
    { strong: 'Dynamo', weak: 'Renegade', reason: 'Dynamo can get back into the play after an unexpected touch sends it the other way.' },
    { strong: 'Renegade', weak: 'Weaver', reason: 'Renegade changes the timing of the challenge, making it harder for Weaver to draw a predictable commitment and slip around it.' }
];

const CLASS_PARTNERSHIPS = [
    { names: ['Weaver', 'Tactician'], reason: 'Weaver can keep the ball moving while Tactician gets into position for the next touch.' },
    { names: ['Bulwark', 'Dynamo'], reason: 'Bulwark holds space while Dynamo moves up to support or gets back after a lost ball.' },
    { names: ['Bulwark', 'Catalyst'], reason: 'Bulwark covers behind the first challenge, giving Catalyst room to start the move.' },
    { names: ['Catalyst', 'Opportunist'], reason: 'Catalyst draws the challenge; Opportunist looks for the loose ball or the gap it leaves.' },
    { names: ['Tactician', 'Renegade'], reason: 'Tactician can cover the space behind an unexpected touch, giving Renegade room to improvise.' },
    { names: ['Opportunist', 'Renegade'], reason: 'An unexpected touch from Renegade can leave a loose ball or open angle for Opportunist to use.' }
];

function classesPage(){
  render(`<div class="hero"><div class="eyebrow">PLAYSTYLE ARCHETYPES</div><h1>Classes</h1><p>Classes describe how someone plays Bonk.io football. Players can share traits from more than one class.</p></div><div class="classes-grid">${PLAYER_CLASSES.map(c=>`<section class="card class-card"><div class="eyebrow">${esc(c.id)}</div><h2>${esc(c.name)}</h2><p>${esc(c.summary)}</p><button class="secondary" data-class-details="${c.id}" aria-haspopup="dialog">More details</button></section>`).join('')}</div>`);
  V.querySelectorAll('[data-class-details]').forEach(button=>button.onclick=()=>openClassDetails(PLAYER_CLASSES.find(c=>c.id===button.dataset.classDetails),button));
}

function openClassDetails(c,opener){
    if (!c) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'class-dialog';
    dialog.setAttribute('aria-labelledby', 'classDialogTitle');
    dialog.innerHTML = `<div class="app-dialog-heading"><h2 id="classDialogTitle" tabindex="-1"></h2><button type="button" class="secondary dialog-dismiss" data-class-close>&times;</button></div><figure class="class-example"><div class="class-video-stage"></div><figcaption class="class-dialog-body"></figcaption></figure>`;
    const title = dialog.querySelector('#classDialogTitle');
    const close = dialog.querySelector('[data-class-close]');
    const videoStage = dialog.querySelector('.class-video-stage');
    const body = dialog.querySelector('.class-dialog-body');

    function relationshipGroup(label, type, entries) {
        return `<section class="class-relationship-group" data-relationship="${type}" aria-labelledby="classRelationship-${type}"><h4 id="classRelationship-${type}">${label}</h4><ul>${entries.map(entry => {
            const related = PLAYER_CLASSES.find(playstyle => playstyle.name === entry.name);
            return `<li><button type="button" class="class-relationship-link" data-related-class="${esc(related.id)}" aria-label="Read ${esc(related.name)} playstyle">${esc(related.name)} <span aria-hidden="true">&#8594;</span></button><p>${esc(entry.reason)}</p></li>`;
        }).join('')}</ul></section>`;
    }

    function showDetails(playstyle, switching = false) {
        videoStage.querySelector('video')?.pause();
        title.textContent = playstyle.name;
        close.setAttribute('aria-label', `Close ${playstyle.name} details`);
        videoStage.innerHTML = playstyle.video
            ? `<video controls playsinline preload="metadata" aria-label="${esc(playstyle.name)} example"><source src="${esc(playstyle.video)}" type="${esc(playstyle.videoType)}">Your browser does not support this video. <a href="${esc(playstyle.video)}">Download the example</a>.</video>`
            : '<div class="class-video-placeholder"><span aria-hidden="true">&#9654;</span><strong>Example video coming soon</strong><p>An example clip will be added here.</p></div>';
        const strong = CLASS_MATCHUPS.filter(matchup => matchup.strong === playstyle.name)
            .map(matchup => ({ name: matchup.weak, reason: matchup.reason }));
        const weak = CLASS_MATCHUPS.filter(matchup => matchup.weak === playstyle.name)
            .map(matchup => ({ name: matchup.strong, reason: matchup.reason }));
        const teammates = CLASS_PARTNERSHIPS.filter(pair => pair.names.includes(playstyle.name))
            .map(pair => ({ name: pair.names.find(name => name !== playstyle.name), reason: pair.reason }));
        body.innerHTML = `${playstyle.detail ? `<p>${esc(playstyle.detail)}</p>` : ''}<p><strong>In attack:</strong> ${esc(playstyle.attack)}</p><p><strong>In defence:</strong> ${esc(playstyle.defence)}</p><p class="meta">${esc(playstyle.example)}</p><section class="class-relationships" aria-labelledby="classRelationshipsTitle"><h3 id="classRelationshipsTitle">Matchups &amp; teammates</h3><p class="meta">Potential matchups and pairings. Position, teammates and individual skill can change how they play out.</p><div class="class-relationships-grid">${relationshipGroup('Strong against', 'strong', strong)}${relationshipGroup('Weak against', 'weak', weak)}${relationshipGroup('Works well with', 'teammates', teammates)}</div></section>`;
        body.scrollTop = 0;
        if (switching) title.focus({ preventScroll: true });
    }

    body.addEventListener('click', event => {
        const button = event.target.closest('[data-related-class]');
        if (!button) return;
        const related = PLAYER_CLASSES.find(playstyle => playstyle.id === button.dataset.relatedClass);
        if (related) showDetails(related, true);
    });
    close.onclick = () => dialog.close();
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
        videoStage.querySelector('video')?.pause();
        dialog.remove();
        if (opener?.isConnected) opener.focus({ preventScroll: true });
    }, { once: true });
    showDetails(c);
    document.body.append(dialog);
    dialog.showModal();
    close.focus({ preventScroll: true });
}
