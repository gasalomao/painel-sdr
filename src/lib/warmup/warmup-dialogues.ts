/**
 * Banco de diálogos nativos, Spintax contextual e curvas de entropia humana
 * para maturação de chips no WhatsApp (pt-BR).
 * Conversas naturais, cotidianas e informais, simulando interações reais entre conhecidos.
 */

export interface DialogueScript {
  id: string;
  theme: string;
  turns: Array<{
    speaker: "A" | "B";
    text: string;
    variants?: string[];
    reaction?: string;
    sendAudioInstead?: boolean;
    audioCaption?: string;
  }>;
}

export const WARMUP_THEMES = [
  { id: "dia_a_dia", label: "Dia a Dia & Rotina (Rotativo)", icon: "Coffee" },
  { id: "futebol", label: "Futebol & Esportes", icon: "Trophy" },
  { id: "trabalho", label: "Trabalho & Projetos", icon: "Briefcase" },
  { id: "churrasco", label: "Churrasco & Fim de Semana", icon: "Flame" },
  { id: "tecnologia", label: "Tecnologia & Celulares", icon: "Cpu" },
  { id: "compras", label: "Compras & Dicas", icon: "ShoppingBag" },
] as const;

export const NATURAL_REACTIONS = ["👍", "❤️", "😂", "🔥", "👏", "👊", "🙌", "✨", "🤝", "😄", "🙏"];

export const STATUS_STORIES_QUOTES = [
  "Começando o dia com aquele cafezinho ☕🙏",
  "Bora pra mais um dia de batalha! Foco nas metas 💪",
  "Dia corrido por aqui, mas sempre com gratidão ✨",
  "Sextou com a graça de Deus! Bom fim de semana a todos 🍻",
  "Mais um dia produtivo finalizado! Descanso merecido 🛋️",
  "Trabalho em equipe faz toda a diferença 👊🚀",
  "Almoço caprichado de hoje! Recarregando as energias 🥗",
  "Aquele clássico cafezinho da tarde pra salvar o expediente ☕",
  "Domingo de paz e descanso com a família ☀️",
  "Novos projetos saindo do papel! Vamos pra cima 🎯",
  "Foco, paciência e constância — um passo de cada vez 🙏",
  "Nada melhor que resolver pendências logo cedo ✅",
  "Semana começando a todo vapor por aqui 🚀",
  "Pausa rápida pro café porque ninguém é de ferro ☕😄",
  "Trânsito hoje tá daquele jeito, paciência redobrada 🚗",
  "Gratidão por mais uma semana abençoada 🙌",
  "Organizando as metas do mês, vem coisa boa por aí 📈",
  "Fim de tarde tranquilo graças a Deus 🌅",
  "Bora fechar o dia com chave de ouro 💪",
  "Chuva boa pra refrescar um pouco 🌧️",
  "Sábado de colocar as coisas em ordem por aqui 🏡",
  "Sempre aprendendo algo novo todo dia 📚✨",
  "Aquele pós-almoço que pede um expresso urgente ☕",
  "Dia de reuniões produtivas e bons alinhamentos 🤝",
];

export const CASUAL_VOICE_NOTES = [
  "Opa beleza? Correria pura aqui mano, já te respondo com calma!",
  "Fala cara, tranquilo? Vi sua mensagem aqui, show de bola!",
  "Beleza meu querido, valeu pelo toque, tamo junto!",
  "Opa meu amigo, tudo em paz por aí? Depois me dá um alô!",
  "Fala parceiro, fechadíssimo então, qualquer coisa me avisa!",
  "Oi! Tô na rua agora resolvendo umas coisas, chegando já te chamo!",
  "Boa! Deixa comigo que mais tarde te passo certinho como ficou.",
  "Tranquilo demais mano, vamos falando sim, um abraço!",
  "Perfeito, acabei de ouvir aqui, concordo 100% contigo!",
  "Opa, valeu mesmo por avisar, salvou demais!",
  "Show! Assim que eu sair da reunião aqui te dou um retorno.",
  "Beleza pura, combinado então, mais tarde a gente se fala!",
];

export const FALLBACK_SCRIPTS: DialogueScript[] = [
  {
    id: "dia_a_dia_1",
    theme: "dia_a_dia",
    turns: [
      {
        speaker: "A",
        text: "Fala mano, tudo bem por aí?",
        variants: [
          "Fala mano, tudo bem por aí?",
          "Opa, tudo tranquilo por aí?",
          "E aí meu querido, como estão as coisas?",
          "Fala parceiro, tudo na paz?",
        ],
        reaction: "👍",
      },
      {
        speaker: "B",
        text: "Opa, tudo em paz! E contigo, como tá a correria?",
        variants: [
          "Opa, tudo em paz! E contigo, como tá a correria?",
          "Tudo tranquilo graças a Deus! E por aí, muito movimento?",
          "Tudo certo por aqui mano! E você, na correria de sempre?",
          "Na paz! Hoje o dia já começou agitado por aqui haha e aí?",
        ],
        reaction: "🙌",
      },
      {
        speaker: "A",
        text: "Bastante trabalho hoje cara, cafezinho salvando a tarde haha",
        variants: [
          "Bastante trabalho hoje cara, cafezinho salvando a tarde haha",
          "Correria boa, já tô no segundo café do dia pra dar conta kkk",
          "Aqui tbm tá puxado hoje, mas devagar a gente coloca tudo em dia",
          "Nem me fale, resolvendo mil coisas ao mesmo tempo hoje rs",
        ],
        reaction: "😂",
      },
      {
        speaker: "B",
        text: "Sei bem como é kkk aqui também tá uma loucura sem fim",
        variants: [
          "Sei bem como é kkk aqui também tá uma loucura sem fim",
          "Haha faz parte, semana toda nesse ritmo por aqui tbm",
          "Café é lei né mano, sem ele não rende nada kkk",
          "Imagino! Mas importante é que as coisas tão andando bem",
        ],
        reaction: "👊",
      },
      {
        speaker: "A",
        text: "Mas é isso aí, logo mais sextou",
        variants: [
          "Mas é isso aí, logo mais dá pra descansar um pouco",
          "Verdade, bora manter o foco que já já a semana compensa",
          "Com certeza, vamo que vamo que hoje ainda tem chão",
          "Exatamente mano, foco total aqui pra terminar cedo hoje",
        ],
        reaction: "🔥",
      },
      {
        speaker: "B",
        text: "Amém! Bom trampo aí parceiro, tamo junto!",
        variants: [
          "Amém! Bom trampo aí parceiro, tamo junto!",
          "Show de bola! Bom trabalho por aí, qualquer coisa chama",
          "Boa! Vai com tudo aí meu amigo, abraço!",
          "Tamo junto mano, ótimo resto de dia pra você!",
        ],
        reaction: "👍",
      },
    ],
  },
  {
    id: "dia_a_dia_2",
    theme: "dia_a_dia",
    turns: [
      {
        speaker: "A",
        text: "E aí cara, sumido! Como você tá?",
        variants: [
          "E aí cara, sumido! Como você tá?",
          "Fala meu amigo, quanto tempo! Tudo certo contigo?",
          "Opa, passando pra dar um alô! Tudo bem por aí?",
          "E aí grande, como estão as coisas por esses lados?",
        ],
        reaction: "👋",
      },
      {
        speaker: "B",
        text: "E aí! Tudo certo por aqui, correria do dia a dia mesmo. E você?",
        variants: [
          "E aí! Tudo certo por aqui, correria do dia a dia mesmo. E você?",
          "Opa! Sumido nada, só trabalhando bastante mesmo haha e contigo?",
          "Fala! Tudo ótimo graças a Deus, semana voando por aqui. E você?",
          "Grande! Tudo em ordem na medida do possível, e por aí?",
        ],
        reaction: "👍",
      },
      {
        speaker: "A",
        text: "Tudo bem também, só na batalha. Tempo virou aí também?",
        variants: [
          "Tudo bem também, só na batalha. Tempo virou aí também?",
          "Por aqui tudo em paz! Rapaz, o clima hoje mudou do nada né?",
          "Na luta de sempre! Aí na sua região também tá ameaçando chover?",
          "Graças a Deus tudo fluindo! Só esse tempo maluco que não decide se faz sol ou chove rs",
        ],
        reaction: "🌧️",
      },
      {
        speaker: "B",
        text: "Nossa demais, esfriou do nada aqui hoje cedo",
        variants: [
          "Nossa demais, mudou do nada aqui hoje cedo",
          "Sim cara, ontem tava um calorão e hoje já virou totalmente",
          "Aqui também fechou o tempo, tive até que pegar um guarda-chuva",
          "Exatamente kkk cada hora uma estação diferente no mesmo dia",
        ],
        reaction: "🥶",
      },
      {
        speaker: "A",
        text: "Pois é, clima doido. Se cuida aí viu!",
        variants: [
          "Pois é, clima doido. Se cuida aí viu!",
          "Desse jeito mesmo haha se cuida por aí meu querido!",
          "Tem que ficar esperto pra não pegar friagem. Bom dia de trabalho aí!",
          "É isso aí, depois a gente combina de tomar um café com calma!",
        ],
        reaction: "👊",
      },
      {
        speaker: "B",
        text: "Valeu mano, pra você também! Abraço",
        variants: [
          "Valeu mano, pra você também! Abraço",
          "Combinado! Se cuida também, grande abraço!",
          "Show, vamos marcar sim! Tudo de bom aí!",
          "Brigadão parceiro, igualmente pra você!",
        ],
        reaction: "🙌",
      },
    ],
  },
  {
    id: "dia_a_dia_3",
    theme: "dia_a_dia",
    turns: [
      {
        speaker: "A",
        text: "Opa, conseguiu almoçar tranquilo hoje ou foi na correria?",
        variants: [
          "Opa, conseguiu almoçar tranquilo hoje ou foi na correria?",
          "Fala! Hoje deu tempo de parar pra almoçar com calma?",
          "E aí, já fez a pausa pro almoço ou ainda tá na pendência?",
        ],
        reaction: "🍽️",
      },
      {
        speaker: "B",
        text: "Hoje consegui parar uns 40 minutinhos, fez toda diferença!",
        variants: [
          "Hoje consegui parar uns 40 minutinhos, fez toda diferença!",
          "Rapaz, almocei rapidinho aqui perto mesmo porque a tarde tá cheia",
          "Acabei de voltar do almoço, agora bateu aquele sono clássico kkk",
        ],
        reaction: "😂",
      },
      {
        speaker: "A",
        text: "Haha clássico demais, só um expresso forte pra acordar agora",
        variants: [
          "Haha clássico demais, só um expresso forte pra acordar agora",
          "Depois do almoço dá uma quebrada mesmo, café salva demais",
          "Tem que fazer essa pausa senão a cabeça não aguenta até as 18h",
        ],
        reaction: "☕",
      },
      {
        speaker: "B",
        text: "Puríssima verdade! Já passei um café fresco aqui pra aguentar o segundo tempo",
        variants: [
          "Puríssima verdade! Já passei um café fresco aqui pra aguentar o segundo tempo",
          "Nem fala, já tô com a caneca do lado aqui pra render a tarde",
          "Isso aí, hidratar e mandar bala nas entregas de hoje",
        ],
        reaction: "🔥",
      },
      {
        speaker: "A",
        text: "Boa! Vou voltar pras planilhas aqui também, mais tarde a gente se fala",
        variants: [
          "Boa! Vou voltar pras planilhas aqui também, mais tarde a gente se fala",
          "Show, vou adiantar umas ligações aqui então, bom expediente aí!",
          "Perfeito mano, boa tarde de trabalho por aí!",
        ],
        reaction: "👍",
      },
      {
        speaker: "B",
        text: "Vai lá, bom foco aí! Qualquer novidade me chama",
        variants: [
          "Vai lá, bom foco aí! Qualquer novidade me chama",
          "Valeu! Pra nós todos, até mais tarde!",
          "Tamo junto, bom trabalho aí também!",
        ],
        reaction: "🤝",
      },
    ],
  },
  {
    id: "dia_a_dia_4",
    theme: "dia_a_dia",
    turns: [
      {
        speaker: "A",
        text: "Cara, o trânsito hoje cedo tava absurdo aí pros seus lados também?",
        variants: [
          "Cara, o trânsito hoje cedo tava absurdo aí pros seus lados também?",
          "Mano, pegou muito trânsito hoje ou foi tranquilo?",
          "Rapaz, hoje a avenida principal tava travadaça, viu isso?",
        ],
        reaction: "🚗",
      },
      {
        speaker: "B",
        text: "Tava tudo parado! Levei quase o dobro do tempo normal pra chegar",
        variants: [
          "Tava tudo parado! Levei quase o dobro do tempo normal pra chegar",
          "Nem me fale,Waze mandou dar uma volta gigante por dentro do bairro",
          "Por sorte saí uns 15 minutos antes hoje, escapei por pouco!",
        ],
        reaction: "😅",
      },
      {
        speaker: "A",
        text: "Waze salvando vidas como sempre haha qualquer obra já trava tudo",
        variants: [
          "Waze salvando vidas como sempre haha qualquer obra já trava tudo",
          "Qualquer chuvinha ou horário de pico já vira um caos né",
          "Eu fui ouvindo podcast pra não estressar no caminho rs",
        ],
        reaction: "👍",
      },
      {
        speaker: "B",
        text: "Melhor coisa que você faz, ligar um som ou podcast e ir na paciência",
        variants: [
          "Melhor coisa que você faz, ligar um som ou podcast e ir na paciência",
          "Exato, não adianta buzinar que ninguém voa kkk",
          "Haha boa, negócio é sair mais cedo mesmo pra ir sem pressa",
        ],
        reaction: "🙌",
      },
      {
        speaker: "A",
        text: "Com certeza! Bom, deixa eu correr aqui que começou reunião",
        variants: [
          "Com certeza! Bom, deixa eu correr aqui que começou reunião",
          "Total! Vou atender um cliente aqui agora, já nos falamos",
          "Verdade! Boa jornada aí hoje meu amigo",
        ],
        reaction: "👊",
      },
      {
        speaker: "B",
        text: "Beleza pura, boa reunião lá! Abraço",
        variants: [
          "Beleza pura, boa reunião lá! Abraço",
          "Tranquilo, manda ver lá! Valeu",
          "Show, até mais!",
        ],
        reaction: "👍",
      },
    ],
  },
  {
    id: "futebol_1",
    theme: "futebol",
    turns: [
      {
        speaker: "A",
        text: "Viu o jogo ontem mano?",
        variants: [
          "Viu o jogo ontem mano?",
          "E aí, assistiu a partida ontem à noite?",
          "Rapaz, acompanhou a rodada de ontem?",
        ],
        reaction: "⚽",
      },
      {
        speaker: "B",
        text: "Vi sim cara, inacreditável aquele gol no final!",
        variants: [
          "Vi sim cara, inacreditável aquele gol no final!",
          "Assisti até o último minuto, que jogo tenso foi aquele!",
          "Vi os melhores momentos hoje cedo, jogaço demais!",
        ],
        reaction: "😱",
      },
      {
        speaker: "A",
        text: "Achei que ia dar empate fácil, o time jogou muito nos acréscimos",
        variants: [
          "Achei que ia dar empate fácil, o time jogou muito nos acréscimos",
          "Quando entrou o reserva no segundo tempo mudou completamente o ritmo",
          "O goleiro também salvou umas duas bolas absurdas ali no fim",
        ],
        reaction: "🔥",
      },
      {
        speaker: "B",
        text: "Pois é, os caras não desistiram. Domingo promete ser pedreira agora",
        variants: [
          "Pois é, os caras não desistiram. Domingo promete ser pedreira agora",
          "Agora o campeonato embolou de vez na parte de cima da tabela",
          "Próxima rodada vai ser teste pra cardíaco com certeza kkk",
        ],
        reaction: "👊",
      },
      {
        speaker: "A",
        text: "Com certeza, clássico é clássico! Vai assistir onde?",
        variants: [
          "Com certeza, clássico é clássico! Vai assistir onde?",
          "Jogão mesmo! Deve reunir a galera pra assistir no fim de semana?",
          "Nem fala! Essa semana promete muita resenha até o jogo",
        ],
        reaction: "🤔",
      },
      {
        speaker: "B",
        text: "Devo colar em casa mesmo com a família. Bora ver depois se dá pra marcar um!",
        variants: [
          "Devo colar em casa mesmo com a família. Bora ver depois se dá pra marcar um!",
          "Capaz de ver em casa mesmo fazendo um petisco, aparece lá!",
          "Vamos combinar sim de assistir juntos qualquer dia desses!",
        ],
        reaction: "👏",
      },
    ],
  },
  {
    id: "futebol_2",
    theme: "futebol",
    turns: [
      {
        speaker: "A",
        text: "Mano, seu time tá jogando demais esse ano hein",
        variants: [
          "Mano, seu time tá jogando demais esse ano hein",
          "Rapaz, o meio de campo do seu time encaixou muito bem nessa fase",
          "Olha, fazia tempo que não via uma sequência tão boa na temporada",
        ],
        reaction: "🔥",
      },
      {
        speaker: "B",
        text: "Nem fala kkk até que enfim começou a acertar o passe!",
        variants: [
          "Nem fala kkk até que enfim começou a acertar o passe!",
          "Demorou mas engrenou haha torcida já tava sem paciência",
          "Rapaz, nem tô acreditando ainda, pé no chão sempre kkk",
        ],
        reaction: "😂",
      },
      {
        speaker: "A",
        text: "O técnico conseguiu ajeitar a zaga, ficou bem mais consistente",
        variants: [
          "O técnico conseguiu ajeitar a zaga, ficou bem mais consistente",
          "A defesa parou de bater cabeça, isso dá outra tranquilidade pro ataque",
          "E o contra-ataque tá muito rápido também, difícil segurar",
        ],
        reaction: "👍",
      },
      {
        speaker: "B",
        text: "Verdade, antes levava gol bobo todo jogo. Agora tomara que mantenha o ritmo",
        variants: [
          "Verdade, antes levava gol bobo todo jogo. Agora tomara que mantenha o ritmo",
          "Sim, o calendário é puxado mas o elenco tá respondendo bem",
          "Exato, se não tiver lesão dá pra brigar lá em cima até o fim",
        ],
        reaction: "🙌",
      },
      {
        speaker: "A",
        text: "Se mantiver leva o título fácil",
        variants: [
          "Se mantiver esse padrão briga forte pela taça",
          "Com certeza vai dar trabalho nos mata-matas",
          "Futebol brasileiro muda rápido mas o momento é excelente",
        ],
        reaction: "🏆",
      },
      {
        speaker: "B",
        text: "Tomara Deus! Vamos ver a próxima rodada",
        variants: [
          "Tomara Deus! Vamos ver a próxima rodada",
          "Bora torcer! Quarta-feira já tem mais um desafio",
          "É isso aí, um jogo de cada vez! Valeu mano",
        ],
        reaction: "👊",
      },
    ],
  },
  {
    id: "churrasco_1",
    theme: "churrasco",
    turns: [
      {
        speaker: "A",
        text: "E aí meu querido, animado pro fim de semana?",
        variants: [
          "E aí meu querido, animado pro fim de semana?",
          "Fala parceiro, quais os planos pro sabadão?",
          "Opa, semana quase acabando, já pensou na programação do fds?",
        ],
        reaction: "🥩",
      },
      {
        speaker: "B",
        text: "Opa, com certeza! Precisando dar uma relaxada",
        variants: [
          "Opa, com certeza! Precisando dar uma relaxada",
          "Mais que preparado haha semana foi intensa por aqui",
          "Tranquilo por enquanto, querendo descansar e reunir os amigos",
        ],
        reaction: "🍻",
      },
      {
        speaker: "A",
        text: "Tava pensando em acender a brasa no sábado, o que acha?",
        variants: [
          "Tava pensando em acender a brasa no sábado, o que acha?",
          "Bora fazer uma carninha na grelha sábado na hora do almoço?",
          "Que tal um churrasquinho de leve pra botar o papo em dia?",
        ],
        reaction: "🔥",
      },
      {
        speaker: "B",
        text: "Boa ideia demais! Posso levar aquela picanha e a cerveja",
        variants: [
          "Boa ideia demais! Posso levar aquela picanha e a cerveja",
          "Tô dentro na hora! Deixa que eu levo a linguiça artesanal e o pão de alho",
          "Convite irrecusável haha já conta comigo que eu levo a fraldinha!",
        ],
        reaction: "👏",
      },
      {
        speaker: "A",
        text: "Fechou! Eu compro o carvão e as bebidas que faltarem",
        variants: [
          "Fechou! Eu compro o carvão e as bebidas que faltarem",
          "Maravilha! Já vou deixar tudo gelando desde sexta à noite",
          "Show! Vou avisar o resto do pessoal pra começarmos lá pelo meio-dia",
        ],
        reaction: "👍",
      },
      {
        speaker: "B",
        text: "Show de bola, combinadíssimo então!",
        variants: [
          "Show de bola, combinadíssimo então!",
          "Fechadíssimo meu amigo, sábado tô encostando lá!",
          "Perfeito, sexta a gente confirma os detalhes finais. Abraço!",
        ],
        reaction: "👊",
      },
    ],
  },
  {
    id: "trabalho_1",
    theme: "trabalho",
    turns: [
      {
        speaker: "A",
        text: "Opa parceiro, conseguiu ver aquele relatório que te mandei?",
        variants: [
          "Opa parceiro, conseguiu ver aquele relatório que te mandei?",
          "Fala! Deu tempo de revisar o material da apresentação de amanhã?",
          "Oi! Viu o cronograma atualizado que subi lá na pasta?",
        ],
        reaction: "📄",
      },
      {
        speaker: "B",
        text: "Fala! Consegui sim, dei uma olhada rápida agora há pouco",
        variants: [
          "Fala! Consegui sim, dei uma olhada rápida agora há pouco",
          "Opa, abri aqui sim, tava justamente analisando os indicadores",
          "Vi sim! Ficou bem organizado, gostei da divisão das etapas",
        ],
        reaction: "👍",
      },
      {
        speaker: "A",
        text: "Ficou claro os números ou acha que precisa detalhar mais alguma coisa?",
        variants: [
          "Ficou claro os números ou acha que precisa detalhar mais alguma coisa?",
          "Acha que tá bom nesse formato ou vale incluir o resumo trimestral?",
          "Se tiver algum ponto que queira ajustar me fala que já edito aqui",
        ],
        reaction: "🤔",
      },
      {
        speaker: "B",
        text: "Achei bem estruturado, só a parte do comparativo mensal que vale destacar",
        variants: [
          "Achei bem estruturado, só a parte do comparativo mensal que vale destacar",
          "Tá ótimo! Só colocaria em negrito as metas da próxima semana",
          "Ficou bem direto ao ponto, acho que o pessoal vai aprovar de primeira",
        ],
        reaction: "💡",
      },
      {
        speaker: "A",
        text: "Perfeito, vou fazer esse ajuste fino antes da reunião amanhã",
        variants: [
          "Perfeito, vou fazer esse ajuste fino antes da reunião amanhã",
          "Boa sugestão! Já vou atualizar a versão final aqui então",
          "Show, em 10 minutinhos já deixo atualizado lá pra todo mundo",
        ],
        reaction: "👏",
      },
      {
        speaker: "B",
        text: "Fechou, vai ficar excelente. Qualquer coisa me dá um toque!",
        variants: [
          "Fechou, vai ficar excelente. Qualquer coisa me dá um toque!",
          "Maravilha, valeu pelo cuidado aí! Até mais",
          "Perfeito parceiro, seguimos alinhados!",
        ],
        reaction: "👊",
      },
    ],
  },
  {
    id: "trabalho_2",
    theme: "trabalho",
    turns: [
      {
        speaker: "A",
        text: "Bom dia! A reunião das 15h continua confirmada no mesmo link?",
        variants: [
          "Opa! A reunião das 15h continua confirmada no mesmo link?",
          "Fala! Nosso alinhamento de hoje à tarde tá mantido às 15h?",
          "Oi! Tudo certo pro nosso call de acompanhamento mais tarde?",
        ],
        reaction: "📅",
      },
      {
        speaker: "B",
        text: "Confirmadíssima! Já separei as pautas principais pra ser bem objetivo",
        variants: [
          "Confirmadíssima! Já separei as pautas principais pra ser bem objetivo",
          "Mantido sim! Vai ser rápido, uns 20 minutinhos só pra fechar a semana",
          "Tudo certo! Mesmo link do Meet de sempre",
        ],
        reaction: "👍",
      },
      {
        speaker: "A",
        text: "Ótimo, já vou levar os dados do fechamento atualizados",
        variants: [
          "Ótimo, já vou levar os dados do fechamento atualizados",
          "Show, já deixei as anotações prontas aqui do meu lado também",
          "Beleza, 5 minutos antes eu já entro na sala",
        ],
        reaction: "🚀",
      },
      {
        speaker: "B",
        text: "Combinado, até às 15h então! Bom trabalho até lá",
        variants: [
          "Combinado, até às 15h então! Bom trabalho até lá",
          "Perfeito, nos falamos mais tarde então!",
          "Fechou, até já!",
        ],
        reaction: "🤝",
      },
    ],
  },
  {
    id: "tecnologia_1",
    theme: "tecnologia",
    turns: [
      {
        speaker: "A",
        text: "E aí mano, você que manja de celular, qual recomendaria até uns 2k?",
        variants: [
          "E aí mano, você que manja de celular, qual recomendaria até uns 2k?",
          "Fala! Tava pesquisando um aparelho intermediário bom de câmera e bateria, alguma dica?",
          "Opa, viu os lançamentos de celular desse mês? Tava pensando em trocar o meu",
        ],
        reaction: "📱",
      },
      {
        speaker: "B",
        text: "Opa! Nessa faixa a linha Galaxy A ou os Redmi tão entregando muito",
        variants: [
          "Opa! Nessa faixa a linha Galaxy A ou os Redmi tão entregando muito",
          "Cara, hoje em dia o A55 ou o Poco X6 tão com custo-benefício excelente",
          "Se quiser bateria que dura dois dias e tela boa, vai de linha intermediária da Samsung ou Xiaomi",
        ],
        reaction: "💡",
      },
      {
        speaker: "A",
        text: "Bateria dura bem o dia todo? Meu foco é mais bateria e tela fluida",
        variants: [
          "Bateria dura bem o dia todo? Meu foco é mais bateria e tela fluida",
          "E não trava usando bastante WhatsApp e aplicativos de banco o dia inteiro?",
          "Show! E o carregamento rápido deles é tranquilo mesmo?",
        ],
        reaction: "🔋",
      },
      {
        speaker: "B",
        text: "Dura sim, tela AMOLED 120hz e bateria de 5000mAh. Vai tranquilo",
        variants: [
          "Dura sim, tela AMOLED 120hz e bateria de 5000mAh. Vai tranquilo",
          "Aguenta o tranco fácil o dia todo e ainda sobra uns 30% à noite",
          "Roda liso demais, com 8GB de RAM não engasga com nada no dia a dia",
        ],
        reaction: "🔥",
      },
      {
        speaker: "A",
        text: "Show de bola, vou dar uma olhada nas promoções hoje",
        variants: [
          "Show de bola, vou dar uma olhada nas promoções hoje",
          "Excelente, vou ativar alerta de preço pra pegar numa promoção boa",
          "Valeu demais pela dica, já me poupou horas de pesquisa!",
        ],
        reaction: "👍",
      },
      {
        speaker: "B",
        text: "Se achar algum link com preço bom me avisa também!",
        variants: [
          "Se achar algum link com preço bom me avisa também!",
          "Tamo junto! Se pintar cupom bom eu te mando aqui",
          "Precisando é só chamar mano, boa compra lá!",
        ],
        reaction: "👊",
      },
    ],
  },
  {
    id: "compras_1",
    theme: "compras",
    turns: [
      {
        speaker: "A",
        text: "Fala meu amigo, chegou aquele pacote que você tava esperando?",
        variants: [
          "Fala meu amigo, chegou aquele pacote que você tava esperando?",
          "E aí, a encomenda do Mercado Livre já foi entregue hoje?",
          "Opa! Deu tudo certo com aquela compra que você fez na internet?",
        ],
        reaction: "📦",
      },
      {
        speaker: "B",
        text: "Chegou hoje de manhã cara! Entrega rápida demais",
        variants: [
          "Chegou hoje de manhã cara! Entrega rápida demais",
          "Entregaram agorinha na portaria, menos de 24h depois de pedir!",
          "Chegou sim! Logística dos caras tá impressionante de rápida",
        ],
        reaction: "🚀",
      },
      {
        speaker: "A",
        text: "Veio tudo certinho ou teve que abrir reclamação?",
        variants: [
          "Veio tudo certinho ou teve que abrir reclamação?",
          "A qualidade é boa mesmo igual nas fotos do anúncio?",
          "Já conseguiu testar pra ver se veio funcionando 100%?",
        ],
        reaction: "🤔",
      },
      {
        speaker: "B",
        text: "Veio 100%, muito bem embalado e funcionou de primeira",
        variants: [
          "Veio 100%, muito bem embalado e funcionou de primeira",
          "Qualidade surpreendeu positivamente, acabamento muito bom mesmo",
          "Testei aqui na hora e bateu certinho com o que eu precisava",
        ],
        reaction: "👍",
      },
      {
        speaker: "A",
        text: "Que top, tava na dúvida se comprava lá. Vou pedir o meu",
        variants: [
          "Que top, tava na dúvida se comprava lá. Vou pedir o meu",
          "Bom saber! Depois me manda o link desse mesmo vendedor",
          "Maravilha, com referência boa assim dá pra comprar tranquilo",
        ],
        reaction: "🔥",
      },
      {
        speaker: "B",
        text: "Pode pedir sem medo, valeu cada centavo!",
        variants: [
          "Pode pedir sem medo, valeu cada centavo!",
          "Já te mando o link aqui, vale muito a pena!",
          "Vai gostar com certeza, ótimo custo-benefício!",
        ],
        reaction: "👏",
      },
    ],
  },
  {
    id: "dia_a_dia_cafe_4",
    theme: "dia_a_dia",
    turns: [
      {
        speaker: "A",
        text: "{saudacao} {mano|parceiro|meu amigo}, passando só pra desejar um bom expediente aí!",
        variants: [
          "{saudacao} {mano|cara}! Passando só pra dar um alô rápido",
          "{saudacao} {meu querido|parceiro}, tudo {tranquilo|na paz} aí hoje?",
          "E aí {mano|amigo}, {saudacao}! Como começou o dia por aí?",
        ],
        reaction: "☕",
      },
      {
        speaker: "B",
        text: "{saudacao}! Por aqui tá {corrido|suave}, acabei de passar um café aqui",
        variants: [
          "{saudacao}! Acabei de fazer um café forte aqui pra engrenar",
          "Tudo {blz|em ordem} por aqui graças a Deus, e vc?",
          "Na correria boa de sempre kkk já no segundo café do dia",
        ],
        reaction: "👍",
      },
      {
        speaker: "A",
        text: "Cafézinho é lei né kkk hoje o dia promete ser longo",
        variants: [
          "Cafézinho salva demais kkk hoje tenho mil coisas pra resolver",
          "Boa! Aqui tbm não vivo sem café logo {cedo|agora}",
          "Massa demais, bora que o dia só tá começando!",
        ],
        reaction: "😄",
      },
      {
        speaker: "B",
        text: "Com certeza! Qualquer coisa que precisar dá um grito aqui",
        variants: [
          "Tamo junto! Qualquer coisa é só chamar aqui",
          "Bora pra cima! Mais tarde a gente vai se falando",
          "Combinado demais, bom trabalho aí {mano|parceiro}!",
        ],
        reaction: "🙏",
      },
    ],
  },
  {
    id: "trabalho_agenda_3",
    theme: "trabalho",
    turns: [
      {
        speaker: "A",
        text: "{saudacao}, consegui organizar a agenda da semana certinho aqui",
        variants: [
          "{saudacao}! Fechei agora o planejamento da semana aqui",
          "E aí {mano|parceiro}, deu certo aquele alinhamento de ontem?",
          "{saudacao}! Hoje tirei a manhã pra responder uns clientes pendentes",
        ],
        reaction: "📈",
      },
      {
        speaker: "B",
        text: "Show de bola! Aqui tbm consegui dar uma enxugada nas pendências",
        variants: [
          "Que massa! Por aqui tbm zerei quase tudo que tava acumulado",
          "Deu certo sim! Organização muda o jogo demais",
          "Top demais, quando organiza logo no começo rende o dobro",
        ],
        reaction: "👏",
      },
      {
        speaker: "A",
        text: "Total! Se eu precisar de uma segunda opinião te mando um áudio depois",
        variants: [
          "Demais! Mais tarde troco uma ideia contigo sobre uns ajustes",
          "Isso aí! Assim que fechar os números aqui te dou um toque",
          "Fechado então, bom foco aí nos atendimentos!",
        ],
        reaction: "🤝",
      },
      {
        speaker: "B",
        text: "Manda sim! Bom trabalho por aí e até mais",
        variants: [
          "Pode mandar sim, tô por aqui hoje!",
          "Valeu demais, excelente dia pra você aí!",
          "Fechadíssimo! Até mais tarde 👋",
        ],
        reaction: "🚀",
      },
    ],
  },
  {
    id: "tecnologia_celular_3",
    theme: "tecnologia",
    turns: [
      {
        speaker: "A",
        text: "{saudacao}! Viu se saiu atualização nova pro Android essa semana?",
        variants: [
          "{saudacao} {mano|cara}, teu celular atualizou o sistema ontem tbm?",
          "E aí, tá usando aquele aplicativo novo de notas ainda?",
          "{saudacao}! Troquei a película aqui e parece celular novo kkk",
        ],
        reaction: "📱",
      },
      {
        speaker: "B",
        text: "Atualizou sim! Achei que a bateria segurou bem melhor agora",
        variants: [
          "Vi sim, atualizei ontem à noite e ficou bem fluido!",
          "Tô usando sim, facilita muito na hora de anotar tudo rápido",
          "Nossa, dá outra cara mesmo kkk bom demais cuidar dos aparelhos",
        ],
        reaction: "✨",
      },
      {
        speaker: "A",
        text: "Boa saber, vou deixar baixando aqui no Wi-Fi pra não gastar os dados",
        variants: [
          "Top! Depois me passa o nome certinho pra eu testar aqui tbm",
          "Verdade, bem melhor fazer no Wi-Fi mesmo pra não dar erro",
          "Pois é, pequeno detalhe mas faz diferença no dia a dia",
        ],
        reaction: "👍",
      },
      {
        speaker: "B",
        text: "Faz isso mesmo! Qualquer bug que notar te aviso aqui kkk",
        variants: [
          "Beleza, te mando o link certinho já já!",
          "Combinado, depois me conta o que achou!",
          "Fechou mano, abraço! 🤝",
        ],
        reaction: "🔥",
      },
    ],
  },
];

function getBrazilClockParts(now: Date = new Date()): { hour: number; weekday: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      hour: "numeric",
      weekday: "short",
      hour12: false,
    }).formatToParts(now);
    const hourVal = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
    const weekday = parts.find((p) => p.type === "weekday")?.value || "Wed";
    return { hour: hourVal === 24 ? 0 : hourVal, weekday };
  } catch {
    return { hour: now.getHours(), weekday: "Wed" };
  }
}

export function resolveWarmupSpintax(template: string, now: Date = new Date()): string {
  const { hour } = getBrazilClockParts(now);
  const greetings =
    hour >= 5 && hour < 12
      ? ["Bom dia", "Bom diaa", "Fala, bom dia"]
      : hour >= 12 && hour < 18
        ? ["Boa tarde", "Boa tardee", "E aí, boa tarde"]
        : ["Boa noite", "Boa noitee", "Fala, boa noite"];

  const chosenGreeting = greetings[Math.floor(Math.random() * greetings.length)];
  let out = template
    .replace(/\{saudacao\}/gi, chosenGreeting)
    .replace(/\{cumprimento\}/gi, chosenGreeting);

  // Expande blocos {opção A|opção B|opção C} sem recursão infinita
  for (let pass = 0; pass < 3; pass++) {
    const next = out.replace(/\{([^{}|]+\|[^{}]+)\}/g, (_match, group: string) => {
      const options = group.split("|").map((s) => s.trim()).filter(Boolean);
      if (options.length === 0) return "";
      return options[Math.floor(Math.random() * options.length)];
    });
    if (next === out) break;
    out = next;
  }

  return out.replace(/\s{2,}/g, " ").trim();
}

function stableHashInt(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getRandomReaction(): string {
  return NATURAL_REACTIONS[Math.floor(Math.random() * NATURAL_REACTIONS.length)];
}

export function getRandomStatusQuote(now: Date = new Date()): string {
  const { weekday, hour } = getBrazilClockParts(now);
  const filtered = STATUS_STORIES_QUOTES.filter((q) => {
    const lower = q.toLowerCase();
    if (lower.includes("sextou") && weekday !== "Fri") return false;
    if (lower.includes("sábado") && weekday !== "Sat") return false;
    if (lower.includes("domingo") && weekday !== "Sun") return false;
    if (lower.includes("começando o dia") && hour >= 13) return false;
    if ((lower.includes("fim de tarde") || lower.includes("finalizado")) && hour < 15) return false;
    return true;
  });
  const pool = filtered.length > 0 ? filtered : STATUS_STORIES_QUOTES;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function getRandomCasualVoiceNote(now: Date = new Date()): string {
  const raw = CASUAL_VOICE_NOTES[Math.floor(Math.random() * CASUAL_VOICE_NOTES.length)];
  return resolveWarmupSpintax(raw, now);
}

/**
 * Resolve o tema efetivo para uma nova conversa:
 * Se o tema configurado for "dia_a_dia" (padrão) ou "todos", sorteia entre todos
 * os temas para evitar que 100% das conversas fiquem presas no mesmo assunto.
 */
export function pickEffectiveConversationTheme(configuredTheme?: string | null): string {
  const allIds = WARMUP_THEMES.map((t) => t.id);
  if (!configuredTheme || configuredTheme === "todos" || configuredTheme === "dia_a_dia") {
    return allIds[Math.floor(Math.random() * allIds.length)];
  }
  return allIds.includes(configuredTheme as (typeof allIds)[number])
    ? configuredTheme
    : allIds[Math.floor(Math.random() * allIds.length)];
}

export function pickFallbackDialogue(theme?: string): DialogueScript {
  const filtered =
    theme && theme !== "todos"
      ? FALLBACK_SCRIPTS.filter((s) => s.theme === theme)
      : FALLBACK_SCRIPTS;

  const pool = filtered.length > 0 ? filtered : FALLBACK_SCRIPTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Seleciona uma fala natural do banco de diálogos travando no mesmo roteiro (`conversationId`)
 * para manter coerência entre perguntas e respostas do início ao fim da thread,
 * evitando repetições recentes e aplicando Spintax contextual por horário de Brasília.
 */
export function pickVariedFallbackTurnText(opts: {
  theme?: string;
  stepIndex: number;
  usedTexts?: string[];
  conversationId?: string;
  now?: Date;
}): string {
  const { theme, stepIndex, usedTexts = [], conversationId, now = new Date() } = opts;
  const usedSet = new Set(usedTexts.map((t) => t.trim().toLowerCase()));

  const themeScripts =
    theme && theme !== "todos"
      ? FALLBACK_SCRIPTS.filter((s) => s.theme === theme)
      : FALLBACK_SCRIPTS;
  const scriptsPool = themeScripts.length > 0 ? themeScripts : FALLBACK_SCRIPTS;

  // 1. Quando conversationId é informado, mantém toda a conversa dentro do MESMO roteiro para coerência
  if (conversationId && scriptsPool.length > 0) {
    const lockedIdx = stableHashInt(conversationId) % scriptsPool.length;
    const lockedScript = scriptsPool[lockedIdx];
    const lockedTurn =
      lockedScript.turns[Math.min(stepIndex, lockedScript.turns.length - 1)] || lockedScript.turns[0];
    if (lockedTurn) {
      const rawPool =
        lockedTurn.variants && lockedTurn.variants.length > 0
          ? lockedTurn.variants
          : [lockedTurn.text];
      const resolvedPool = rawPool.map((v) => resolveWarmupSpintax(v, now));
      const unusedLocked = resolvedPool.filter((v) => v && !usedSet.has(v.toLowerCase()));
      if (unusedLocked.length > 0) {
        return unusedLocked[Math.floor(Math.random() * unusedLocked.length)];
      }
      // Se já usou variantes deste passo, evita repetição exata com candidatos do mesmo tema
    }
  }

  // 2. Fallback: coleta variantes inéditas para o turno em outros roteiros do tema
  const candidates: string[] = [];
  for (const script of scriptsPool) {
    const turn = script.turns[Math.min(stepIndex, script.turns.length - 1)] || script.turns[0];
    if (!turn) continue;
    const pool = turn.variants && turn.variants.length > 0 ? turn.variants : [turn.text];
    for (const v of pool) {
      const resolved = resolveWarmupSpintax(v, now);
      if (resolved && !usedSet.has(resolved.toLowerCase())) {
        candidates.push(resolved);
      }
    }
  }

  let chosen: string;
  if (candidates.length > 0) {
    chosen = candidates[Math.floor(Math.random() * candidates.length)];
  } else {
    const fallbackScript = pickFallbackDialogue(theme);
    const turn =
      fallbackScript.turns[Math.min(stepIndex, fallbackScript.turns.length - 1)] ||
      fallbackScript.turns[0];
    const pool = turn?.variants && turn.variants.length > 0 ? turn.variants : [turn?.text || "Opa, tudo bem por aí?"];
    chosen = resolveWarmupSpintax(pool[Math.floor(Math.random() * pool.length)], now);
  }

  return chosen;
}

/**
 * Calcula duração de digitação humana com variação (3 a 10s), evitando cravar
 * sempre no piso mínimo de 3000ms.
 */
export function calculateTypingDuration(textLength: number, minSec = 3, maxSec = 10): number {
  const minMs = minSec * 1000;
  const maxMs = maxSec * 1000;
  // Velocidade variável entre 55 e 95 ms por caractere + tempo de leitura/pensamento (600 a 1800ms)
  const perCharMs = 55 + Math.floor(Math.random() * 41);
  const thinkMs = 600 + Math.floor(Math.random() * 1200);
  const rawMs = textLength * perCharMs + thinkMs;
  const clamped = Math.min(Math.max(rawMs, minMs), maxMs);
  const jitter = Math.floor(Math.random() * 900) - 450;
  return Math.max(minMs, Math.min(clamped + jitter, maxMs));
}

/**
 * Atraso humano variável para confirmação de leitura (tiques azuis):
 * Em vez de 4200ms fixos, varia entre 3.2s e 18.5s no modo automático.
 */
export function calculateReadReceiptDelayMs(isManualTrigger = false): number {
  if (isManualTrigger) {
    return 1800 + Math.floor(Math.random() * 1400);
  }
  // Distribuição assimétrica: maioria entre 3.5s e 9s, cauda até 18.5s
  const base = 3200;
  const u = Math.random() * Math.random(); // enviesado para leituras naturais rápidas/médias
  return base + Math.floor(u * 15300);
}

/**
 * Atraso humano variável para reação com emoji:
 * Em vez de 7500ms fixos, varia entre 4.2s e 16.0s no modo automático.
 */
export function calculateReactionDelayMs(isManualTrigger = false): number {
  if (isManualTrigger) {
    return 1500 + Math.floor(Math.random() * 1000);
  }
  return 4200 + Math.floor(Math.random() * 11800);
}

/**
 * Intervalo de descanso (cooldown) entre o fim de uma conversa completa e o
 * início de uma nova conversa entre o mesmo par de chips (12 a 35 minutos,
 * escalonado pelo estágio do chip).
 */
export function calculateInterConversationCooldownSec(stage = 1): number {
  const baseMinByStage: Record<number, [number, number]> = {
    1: [25 * 60, 45 * 60], // Fase 1 (Frio): 25 a 45 min entre sessões
    2: [18 * 60, 35 * 60], // Fase 2 (Morno): 18 a 35 min entre sessões
    3: [12 * 60, 25 * 60], // Fase 3 (Quente): 12 a 25 min entre sessões
    4: [10 * 60, 20 * 60], // Fase 4 (Blindado): 10 a 20 min entre sessões
  };
  const [minSec, maxSec] = baseMinByStage[stage] || baseMinByStage[2];
  return minSec + Math.floor(Math.random() * (maxSec - minSec + 1));
}
